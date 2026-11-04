// Smoke test of a running World of DODO server: the static files and the whole protocol with two players
// and the bots. Expects the default of 3 bots (BOTS=3).
// Usage: node tools/smoke.js [http://localhost:3400]
// World of DODO, issue #16: the places come from the map of the real Karlín (client/shared/map.ts, loaded the way the server loads
// it, server/city.js; Node 24 runs the TypeScript), so run it against a server of the same version. Issue #20: the ships' places come
// from the river (client/shared/naval.ts).
'use strict';

const M = require('../server/city');
const NV = require('../client/shared/naval.ts');

const BASE = (process.argv[2] || 'http://localhost:3400').replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const BLUE = 0x4d8dff;
// The shared city's numbers: as many cars and pedestrians as server/world.js runs (its N_CARS and PED_N; issue #16 changed them with
// the bigger city), the old 33 and 50 if it does not say. cars: the traffic, numbered 0..cars-1 (a parked car k is cars + k);
// carRow, pedRow: the numbers per car in snap.c and per pedestrian in w.p (docs/PROTOCOL.md): change them here with the protocol.
const LIFE = require('../server/world');
const CITY = { cars: LIFE.N_CARS ?? 33, peds: LIFE.PED_N ?? 50, carRow: 4, pedRow: 5 };
// the parked cars' spots (issue #16: client/shared/traffic.ts PARK, the same list on the server and every client; the server takes a
// claim on a parked car only near its spot), or null where the city has no such list
const PARK = (() => { try { return require('../client/shared/traffic.ts').PARK || null; } catch { return null; } })();
const WORLD = M.AIR_LIM + 70;               // server/server.js WORLD: the planes' airspace and its margin; rows beyond are ignored
// A's place: the map's spawn point nearest the middle, on a street, where a player's tank may start
const HOME = M.SPAWNS[0];
// a spot off every street, so no bot can run into a parcel there: the middle of an empty lot (the first two are the construction site
// and the depot) at least 8 units from any carriageway
const OFF = (() => {
  for (const l of [...M.DATA.lots.slice(2), ...M.DATA.lots]) {
    const x = Math.round((l[0] + l[2]) / 2 * 100) / 100, z = Math.round((l[1] + l[3]) / 2 * 100) / 100, n = M.nearestEdge(x, z);
    if (n.d - n.e.w / 2 >= 8 && !M.solidAt(x, 1, z)) return { x, z };
  }
  return { x: M.ARENA.x0 + 2, z: M.ARENA.z0 + 2 };
})();
// on the street graph: within a street's carriageway, give or take what a wall pushes a bot aside
const onStreets = (x, z) => { const n = M.nearestEdge(x, z); return !!n && n.d <= n.e.w / 2 + 2; };
// invisible characters a name must lose (built from code points, so none sits in this file)
const RLO = String.fromCharCode(0x202e), ZWSP = String.fromCharCode(0x200b);
let failed = 0;

function check(ok, what) {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) failed++;
}

function client() {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiters = [];
  const last = new Map();                 // id -> the newest snapshot row of that tank
  const track = new Map();                // id -> [[ms, x, z], ...]: every row of the tanks being watched (api.watch)
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'snap') { for (const s of m.p) { last.set(s[0], s); track.get(s[0])?.push([Date.now(), s[1], s[2]]); } api.snap = m; }
    if (m.t === 'w') api.world = m;
    const i = waiters.findIndex(w => w.test(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else if (m.t !== 'snap' && m.t !== 'w') inbox.push(m);
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const closed = new Promise(res => { ws.onclose = e => res(e); });
  const api = {
    ws, opened, closed, last, track, world: null, snap: null,
    send: m => ws.send(JSON.stringify(m)),
    watch: id => track.set(id, []),
    // the next message that passes test (also one that already arrived), or null after ms
    next(test, ms = 2000) {
      const i = inbox.findIndex(test);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise(resolve => {
        const w = { test, resolve };
        waiters.push(w);
        setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); resolve(null); } }, ms);
      });
    },
  };
  return api;
}

const key = () => Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.random() * 26 | 0]).join('');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function refused(hello) {
  const c = client();
  await c.opened;
  c.send({ t: 'hello', key: key(), ...hello });
  const e = await c.next(m => m.t === 'err');
  await c.closed;
  return e && e.code;
}

(async () => {
  // static files
  let r = await fetch(BASE + '/');
  const html = await r.text();
  check(r.status === 200 && html.includes('World of DODO'), 'GET / serves the game');
  check((r.headers.get('content-security-policy') || '').includes("connect-src 'self' ws: wss:"), 'the page has its content policy');
  const app = (html.match(/<script type="module"[^>]*src="(\/app\/[^"]+\.js)"/) || [])[1];
  r = app ? await fetch(BASE + app) : { status: 0, headers: new Headers(), text: async () => '' };
  check(r.status === 200 && (r.headers.get('content-type') || '').startsWith('text/javascript'), `the built game script is served (${app})`);
  check((r.headers.get('cache-control') || '').includes('immutable'), 'the built script may be cached for good (its name changes with it)');
  // issue #16: the page carries the map of Karlín (karlin.json, bundled by Vite) with its sources' attribution
  check((await r.text()).includes(M.DATA.attribution[0]), 'the built script carries the map of Karlín and its attribution');
  r = await fetch(BASE + '/fonts/Poppins-SemiBold.ttf');
  check(r.status === 200, 'fonts are served');
  r = await fetch(BASE + '/assets/logo-white.png');
  check(r.status === 200, 'the logo is served');
  r = await fetch(BASE + '/shared/karlin.json');
  check(r.status === 404, 'client/shared is not served on its own (the page has it built in, the server requires it)');
  r = await fetch(BASE + '/app/..%2f..%2f..%2fserver%2fserver.js');
  // 404 from this server; behind the Zerops balancer the request is refused with 400 before it gets here
  check(r.status === 404 || r.status === 400, `no way out of the client folder (${r.status})`);
  r = await fetch(BASE + '/package.json');
  check(r.status === 404, 'nothing outside the asset folders');
  r = await fetch(BASE + '/health');
  check(r.status === 200 && (await r.json()).ok === true, '/health answers');

  // two players
  const a = client(), b = client();
  await Promise.all([a.opened, b.opened]);
  const ka = key(), kb = key();
  a.send({ t: 'hello', name: '  Tester' + RLO + ' A  ', color: BLUE, key: ka });
  const wa = await a.next(m => m.t === 'welcome');
  check(wa && wa.name === 'Tester A', 'A is welcomed, the name is cleaned (' + (wa && wa.name) + ')');
  check(wa && wa.color === BLUE && wa.pts === 0, 'A gets the colour A picked, and 0 points');
  const botsA = wa ? wa.players.filter(p => p.bot) : [];
  check(botsA.length === 3 && botsA.map(p => p.name).join() === 'BOT1,BOT2,BOT3', 'the first player in finds BOT1, BOT2 and BOT3');
  b.send({ t: 'hello', name: 'Tester B', color: 0x123456, key: kb });
  const wb = await b.next(m => m.t === 'welcome');
  check(wb && wb.players.some(p => p.id === wa.id && p.name === 'Tester A' && !p.bot), 'B is welcomed and sees A');
  check(wb && wb.color !== 0x123456 && wb.color !== BLUE, 'a colour off the palette is replaced by a free one');
  const ja = await a.next(m => m.t === 'join');
  check(ja && ja.p.id === wb.id, 'A hears that B joined');
  r = await fetch(BASE + '/health');
  const hl = await r.json();
  check(hl.players === 2 && hl.bots === 3, `/health counts 2 players and 3 bots (${JSON.stringify(hl)})`);

  // issue #16: where the tanks start. A player's browser picks one of the map's spawn points (client/src/game/tank.ts spawnPoint), the
  // server places the bots on them (server/bots.js placeFar): all on a carriageway, spread over Karlín
  const spread = Math.min(...M.SPAWNS.map((p, i) => Math.min(...M.SPAWNS.filter((q, j) => j !== i).map(q => Math.hypot(p.x - q.x, p.z - q.z)))));
  check(M.SPAWNS.length >= 20 && M.SPAWNS.every(p => M.onRoad(p.x, p.z)) && spread > 20,
    `a player spawns on a road: the map's ${M.SPAWNS.length} spawn points are all on a carriageway, at least ${spread.toFixed(0)} units apart`);
  const sb = await b.next(m => m.t === 'snap' && botsA.every(p => m.p.some(s => s[0] === p.id)));
  const bot0 = sb ? botsA.map(p => sb.p.find(s => s[0] === p.id)) : [];
  check(bot0.length === 3 && bot0.every(s => onStreets(s[1], s[2]) && M.inArena(s[1], s[2])), `the bots are on the streets (${bot0.map(s => s[1].toFixed(0) + ',' + s[2].toFixed(0)).join('; ')})`);
  for (const p of botsA) b.watch(p.id);              // and they are watched from now on: do they keep to the streets? (checked below)
  const watchT = Date.now();

  check(await refused({ name: 'tester a' }) === 'name_taken', 'a taken name is refused (case does not matter)');
  check(await refused({ name: ' ' + ZWSP + ' ' }) === 'name_invalid', 'an empty name is refused');
  check(await refused({ name: 'bot 7' }) === 'name_reserved', 'a bot\'s name is refused');

  a.send({ t: 'ping', c: 12345 });
  const pong = await a.next(m => m.t === 'pong');
  check(pong && pong.c === 12345, 'a ping gets its pong');

  // positions, each stamped with the moment it shows on the server's clock (from the browser's own clock, ct)
  const t0 = Math.round(performance.now());
  a.send({ t: 'st', ct: t0, x: HOME.x, z: HOME.z, h: 1.2, v: 12, r: 0, s: 1 });
  const snap = await b.next(m => m.t === 'snap' && m.p.some(s => s[0] === wa.id));
  const sa = snap && snap.p.find(s => s[0] === wa.id);
  check(sa && sa[1] === HOME.x && sa[2] === HOME.z && sa[6] === 1, 'B gets A\'s position (and the spawn shield) in a snapshot');
  check(snap && typeof snap.ts === 'number' && sa.length === 8 && sa[7] <= snap.ts, 'the snapshot and its rows carry the server\'s clock');
  await sleep(100);
  a.send({ t: 'st', ct: t0 + 100, x: HOME.x, z: HOME.z, h: 1.2, v: 12, r: 0, s: 1 });
  const snapT = await b.next(m => m.t === 'snap' && m.p.some(s => s[0] === wa.id && s[7] > sa[7]));
  const gapT = snapT && snapT.p.find(s => s[0] === wa.id)[7] - sa[7];
  check(gapT >= 80 && gapT <= 120, `two reports 100 ms apart by A's clock are about 100 ms apart on the server's (${gapT})`);
  a.send({ t: 'st', x: WORLD + 1, z: 0, h: 0, v: 0, r: 0 });
  a.send({ t: 'st', x: 0, z: -WORLD - 1, h: 0, v: 30, r: 0, k: 1, y: 50, p: 0 });
  const snap2 = await b.next(m => m.t === 'snap' && m.p.some(s => s[0] === wa.id && s[1] !== HOME.x), 500);
  check(!snap2, `a position outside the world (${WORLD} units from the middle, tank or plane) is ignored`);
  const bot1 = botsA[0], p0 = b.last.get(bot1.id);
  await sleep(1500);                                               // (1.5 s: it may be turning round at a dead end, issue #16)
  const p1 = b.last.get(bot1.id);
  check(p0 && p1 && Math.hypot(p1[1] - p0[1], p1[2] - p0[2]) > 3, 'BOT1 drives around the city');

  // the shared city: every snapshot has the cars and the tram, every other one the pedestrians; a knocked pedestrian falls for everyone
  const s1 = await b.next(m => m.t === 'snap');
  check(s1 && s1.c.length === CITY.cars * CITY.carRow && typeof s1.m === 'number' && Array.isArray(s1.k) && Array.isArray(s1.q), `the shared city arrives: ${CITY.cars} cars and the tram in every snapshot`);
  const w = await b.next(m => m.t === 'w');
  check(w && w.p.length === CITY.peds * CITY.pedRow && typeof w.ts === 'number', `and the ${CITY.peds} pedestrians in every other one`);
  const PR = CITY.pedRow, near = [...Array(CITY.peds).keys()].sort((x, y) => Math.hypot(w.p[x * PR] - HOME.x, w.p[x * PR + 1] - HOME.z) - Math.hypot(w.p[y * PR] - HOME.x, w.p[y * PR + 1] - HOME.z))[0];
  // (a hit counts only for a pedestrian near the hitting tank, PROTOCOL.md: A's tank goes to her first; Karlín is bigger than the old city)
  a.send({ t: 'st', ct: t0 + 150, x: w.p[near * PR], z: w.p[near * PR + 1] - 3, h: 0, v: 6, r: 0, s: 0 });
  a.send({ t: 'ped', i: near, vx: 6, vz: 0 });
  const fell = await b.next(m => m.t === 'w' && m.p[near * PR + 3] > 0, 3000);
  check(!!fell, `pedestrian ${near}, hit by A, falls on B's screen too`);
  const lay = fell && b.world;
  await sleep(4000);
  const still = b.world && b.world.p[near * PR + 3] > 1;
  const back = fell && await b.next(m => m.t === 'w' && m.p[near * PR + 3] === 0, 15000);
  const moved = back && Math.hypot(back.p[near * PR] - lay.p[near * PR], back.p[near * PR + 1] - lay.p[near * PR + 1]);
  check(still && back && moved > 6, `she stays down a while, then walks again elsewhere (${moved ? moved.toFixed(0) : '?'} units away)`);
  // a car A's tank shoves becomes A's: A reports it, B sees it there, nobody else can take it until A lets go
  const ownerOf = (m, i) => { const k = m && m.k.find(r => r[0] === i); return k ? k[1] : 0; };
  const carAt = (m, i) => m && [m.c[i * CITY.carRow], m.c[i * CITY.carRow + 1], m.c[i * CITY.carRow + 2]];
  const P0 = CITY.cars;                                             // the first parked car's index
  const [cx, cz, ch] = carAt(b.snap, 0);
  a.send({ t: 'st', ct: t0 + 200, x: cx, z: cz, h: 0, v: 5, r: 0, s: 0, c: [[0, cx + 1, cz, ch, 3, 0]] });
  const own = await b.next(m => m.t === 'snap' && ownerOf(m, 0) === wa.id);
  check(own && Math.abs(own.c[0] - (cx + 1)) < 0.01 && own.k.find(r => r[0] === 0)[3] === Math.round((cx + 1) * 100) / 100, 'a car A shoves is A\'s: B sees it where A reports it');
  b.send({ t: 'st', ct: 1, x: cx, z: cz, h: 0, v: 0, r: 0, s: 0, c: [[0, cx + 3, cz, ch, 0, 0]] });
  await sleep(150);
  check(ownerOf(b.snap, 0) === wa.id && Math.abs(b.snap.c[0] - (cx + 1)) < 0.01, 'B cannot take it over while A pushes it');
  a.send({ t: 'st', ct: t0 + 250, x: cx, z: cz, h: 0, v: 0, r: 0, s: 0, c: [[0, cx + 1, cz, ch, 0, 1]] });
  const free = await b.next(m => m.t === 'snap' && !ownerOf(m, 0));
  check(!!free, 'when A lets go, the car belongs to the traffic again');
  const spot = PARK && PARK[0] ? { x: PARK[0].x, z: PARK[0].z } : { x: cx, z: cz };   // A's tank goes to the first parked car
  a.send({ t: 'st', ct: t0 + 300, x: spot.x, z: spot.z, h: 0, v: 0, r: 0, s: 0, c: [[P0, spot.x + 2, spot.z + 4, 0, 1, 0]] });
  const pk = await b.next(m => m.t === 'snap' && ownerOf(m, P0) === wa.id);
  a.send({ t: 'st', ct: t0 + 350, x: spot.x, z: spot.z, h: 0, v: 0, r: 0, s: 0, c: [[P0, spot.x + 2, spot.z + 4, 0, 0, 1]] });
  const pq = await b.next(m => m.t === 'snap' && m.q.some(r => r[0] === P0));
  check(pk && pq && Math.abs(pq.q.find(r => r[0] === P0)[1] - (spot.x + 2)) < 0.01, 'a parked car A pushed away stays where A left it, for B too');
  a.send({ t: 'st', ct: t0 + 400, x: cx, z: cz, h: 0, v: 0, r: 0, s: 0, c: [[1, cx + 200, cz, 0, 1, 0]] });
  await sleep(150);
  check(!ownerOf(b.snap, 1), 'a car far from the tank cannot be claimed');
  a.send({ t: 'st', ct: t0 + 450, x: HOME.x, z: HOME.z, h: 1.2, v: 0, r: 0, s: 0 });

  // (a tree that stands: one knocked down by an earlier run against this server stays down for 90 s)
  const TREE = [...Array(200).keys()].find(i => !wa.props.some(p => p[0] === i));
  a.send({ t: 'prop', i: TREE, fx: 1, fz: 0 });
  const pb = await b.next(m => m.t === 'prop');
  check(pb && pb.i === TREE && pb.fx === 1 && !pb.up, 'a tree A knocked down falls for B');
  a.send({ t: 'prop', i: TREE, fx: 0, fz: 1 });
  check(!(await b.next(m => m.t === 'prop', 500)), 'a tree that is down already is not knocked down again');

  // a parcel (straight up, off every street, so no bot can run into it), a hit, the points
  a.send({ t: 'fire', sid: 1, x: OFF.x, y: 1.5, z: OFF.z, vx: 0, vy: 4, vz: 0 });
  const fb = await b.next(m => m.t === 'fire' && m.id === wa.id);
  check(fb && fb.sid === 1 && fb.vy === 4, 'B gets A\'s parcel');
  b.send({ t: 'hit', by: wa.id, sid: 1 });
  const [ha, hb] = await Promise.all([a.next(m => m.t === 'hit' && m.v === wb.id), b.next(m => m.t === 'hit' && m.v === wb.id)]);
  check(ha && ha.by === wa.id && ha.pts === 10 && ha.gain === 10 && !ha.kill && hb && hb.pts === 10, 'a hit on a player scores 10 for A, both hear it');
  b.send({ t: 'hit', by: wa.id, sid: 1 });
  check(!(await a.next(m => m.t === 'hit' && m.v === wb.id, 500)), 'the same parcel does not score twice');
  b.send({ t: 'hit', by: wa.id, sid: 99 });
  check(!(await a.next(m => m.t === 'hit' && m.v === wb.id, 500)), 'a parcel that was never fired does not score');
  a.send({ t: 'hit', by: wa.id, sid: 1 });
  check(!(await a.next(m => m.t === 'hit' && m.v === wa.id, 500)), 'nobody scores by hitting themselves');
  a.send({ t: 'fire', sid: 2, x: OFF.x, y: 1.5, z: OFF.z, vx: 0, vy: 4, vz: 0 });
  await b.next(m => m.t === 'fire' && m.id === wa.id && m.sid === 2);
  b.send({ t: 'hit', by: wa.id, sid: 2, kill: true });
  const hk = await b.next(m => m.t === 'hit' && m.v === wb.id);
  check(hk && hk.kill === true && hk.pts === 20, 'the hit that destroys B is passed on as a kill');

  // a parcel dropped onto a bot: the server flies it and scores 1 point
  let hbot = null;
  for (let i = 0; i < 4 && !hbot; i++) {
    const s = a.last.get(bot1.id);
    if (!s) { await sleep(200); continue; }
    const [, x, z, h, v] = s, back = v * 0.15;                // the server tests against where the bot was 200 ms ago
    a.send({ t: 'fire', sid: 10 + i, x: x - Math.sin(h) * back, y: 1.0, z: z - Math.cos(h) * back, vx: 0, vy: 0, vz: 0 });
    hbot = await a.next(m => m.t === 'hit' && m.v === bot1.id, 1000);
  }
  check(hbot && hbot.by === wa.id && hbot.gain === 1, 'a parcel on a bot scores 1 point for A');

  // planes (issue #14): a plane's row carries its kind, height and pitch; a bullet's shooter reports its hit (shot), the victim gets it
  // passed on (dmg) and answers like a parcel hit: 3 points for a bullet in a tank, 5 in a plane; a bot fires at a low plane
  const edgeZ = -(M.AIR_LIM + 55);                                // beyond the arena, out at the airspace's edge (the turn-back zone)
  a.send({ t: 'st', ct: t0 + 500, x: 30, z: edgeZ, h: 0, v: 32, r: 0.2, s: 0, k: 1, y: 80, p: 0.1 });
  const sp = await b.next(m => m.t === 'snap' && m.p.some(s => s[0] === wa.id && s[8] === 1));
  const ra = sp && sp.p.find(s => s[0] === wa.id);
  check(ra && ra.length === 11 && ra[9] === 80 && ra[10] === 0.1 && ra[2] === edgeZ, 'a plane\'s row carries its kind, height and pitch, out to the edge of the airspace');
  const rb = b.last.get(wb.id) || [0, 0, 0];                       // A flies over to B (a bullet hit counts within 400 units)
  a.send({ t: 'st', ct: t0 + 505, x: rb[1], z: rb[2] - 40, h: 0, v: 32, r: 0, s: 0, k: 1, y: 20, p: 0 });
  await sleep(120);
  a.send({ t: 'fire', k: 1, sid: 20, x: rb[1], y: 20, z: rb[2] - 38, vx: 0, vy: -50, vz: 190 });
  const fk = await b.next(m => m.t === 'fire' && m.id === wa.id && m.sid === 20);
  check(fk && fk.k === 1 && fk.vz === 190, 'B gets A\'s bullet');
  a.send({ t: 'shot', v: wb.id, sid: 20 });
  const dm = await b.next(m => m.t === 'dmg');
  check(dm && dm.by === wa.id && dm.sid === 20, 'A\'s bullet that hit B on A\'s screen is passed on to B');
  b.send({ t: 'hit', by: wa.id, sid: 20 });
  const hg = await a.next(m => m.t === 'hit' && m.v === wb.id && m.by === wa.id && m.pts > (hbot ? hbot.pts : 20));
  check(hg && hg.gain === 3, 'a bullet in a tank scores 3');
  a.send({ t: 'shot', v: wb.id, sid: 20 });
  a.send({ t: 'shot', v: wb.id, sid: 2 });
  check(!(await b.next(m => m.t === 'dmg', 500)), 'a bullet hits only once, and only a bullet is reported by its shooter');
  b.send({ t: 'fire', k: 1, sid: 21, x: rb[1], y: 2, z: rb[2], vx: 0, vy: 100, vz: -100 });
  b.send({ t: 'shot', v: wa.id, sid: 21 });
  const da = await a.next(m => m.t === 'dmg');
  a.send({ t: 'hit', by: wb.id, sid: 21 });
  const hp = await b.next(m => m.t === 'hit' && m.v === wa.id && m.by === wb.id);
  check(da && hp && hp.gain === 5, 'a bullet in a plane scores 5');
  let flak = null;
  for (let i = 0; i < 25 && !flak; i++) {
    const s = a.last.get(bot1.id);
    if (!s) { await sleep(200); continue; }
    a.send({ t: 'st', ct: t0 + 510 + i, x: s[1], z: s[2], h: 0, v: 20, r: 0, s: 0, k: 1, y: 30, p: 0 });   // right above the bot
    flak = await a.next(m => m.t === 'fire' && m.k === 1 && botsA.some(p => p.id === m.id), 300);
  }
  check(!!flak, 'a bot fires at a low plane above it');

  // issue #20: ships. A ship's row (k 2) carries its heave and sinking, its pitch and its turrets' yaw, and counts only on the river;
  // only a ship fires shells (k 2) and torpedoes (k 3); the victim reports their hits as for a parcel: a shell scores 10 in a tank and
  // 4 in a ship, a torpedo 15; a shell dropped on a bot is flown by the server (1 point). The ships go to the river's spawn points
  // farthest from the arena, out of the bots' hunting range (150).
  const outside = p => Math.hypot(Math.max(M.ARENA.x0 - p.x, 0, p.x - M.ARENA.x1), Math.max(M.ARENA.z0 - p.z, 0, p.z - M.ARENA.z1));
  const [SEA, SEA2] = [...NV.SHIP_SPAWNS].sort((p, q) => outside(q) - outside(p));
  let shipPts = null;
  const ptsNow = m => { if (m && m.by === wa.id) shipPts = m.pts; return m; };
  while (await a.next(m => m.t === 'hit', 200));                     // (hits A heard earlier and no check took: not these)
  a.send({ t: 'st', ct: t0 + 600, x: SEA.x, z: SEA.z, h: SEA.h, v: 8, r: -0.05, s: 0, k: 2, y: 0.03, p: 0.01, a: [0.4, 3] });
  const ss = await b.next(m => m.t === 'snap' && m.p.some(s => s[0] === wa.id && s[8] === 2));
  const rs = ss && ss.p.find(s => s[0] === wa.id);
  check(rs && rs.length === 13 && rs[1] === SEA.x && rs[2] === SEA.z && rs[9] === 0.03 && rs[10] === 0.01 && rs[11] === 0.4 && rs[12] === 3,
    `a ship's row on the river carries its kind, heave, pitch and turrets (${SEA.x}, ${SEA.z}, ${outside(SEA).toFixed(0)} from the arena)`);
  a.send({ t: 'st', ct: t0 + 610, x: HOME.x, z: HOME.z, h: 0, v: 5, r: 0, s: 0, k: 2, y: 0, p: 0, a: [0, 3] });
  a.send({ t: 'st', ct: t0 + 620, x: SEA.x, z: SEA.z, h: SEA.h, v: 20, r: 0, s: 0, k: 2, y: 0, p: 0, a: [0, 3] });
  check(!(await b.next(m => m.t === 'snap' && m.p.some(s => s[0] === wa.id && s[8] === 2 && (s[1] === HOME.x || s[4] === 20)), 500)),
    'a ship\'s row on land (a street of Karlín), or faster than a ship sails, is ignored');
  a.send({ t: 'st', ct: t0 + 630, x: SEA.x, z: SEA.z, h: SEA.h, v: 8, r: 0, s: 0, k: 2, y: 0, p: 0, a: [0, 3] });
  b.send({ t: 'fire', k: 2, sid: 30, x: rb[1], y: 2, z: rb[2], vx: 0, vy: 30, vz: 90 });
  check(!(await a.next(m => m.t === 'fire' && m.id === wb.id && m.sid === 30, 500)), 'a tank cannot fire a ship\'s shell');
  await sleep(100);
  a.send({ t: 'fire', k: 2, sid: 40, x: SEA.x, y: NV.WATER_Y + 3, z: SEA.z, vx: 70, vy: 30, vz: 70 });
  const fs = await b.next(m => m.t === 'fire' && m.id === wa.id && m.sid === 40);
  check(fs && fs.k === 2 && fs.vy === 30, 'B gets A\'s shell');
  b.send({ t: 'hit', by: wa.id, sid: 40 });
  const hst = ptsNow(await a.next(m => m.t === 'hit' && m.v === wb.id && m.by === wa.id));
  check(hst && hst.gain === 10, `a shell in a tank scores 10 (+${hst && hst.gain})`);
  b.send({ t: 'st', ct: 3, x: SEA2.x, z: SEA2.z, h: SEA2.h, v: 0, r: 0, s: 0, k: 2, y: 0, p: 0, a: [0, 3.14] });
  await a.next(m => m.t === 'snap' && m.p.some(s => s[0] === wb.id && s[8] === 2));
  a.send({ t: 'fire', k: 2, sid: 41, x: SEA.x, y: NV.WATER_Y + 3, z: SEA.z, vx: 70, vy: 30, vz: 70 });
  await b.next(m => m.t === 'fire' && m.id === wa.id && m.sid === 41);
  b.send({ t: 'hit', by: wa.id, sid: 41 });
  const hss = ptsNow(await a.next(m => m.t === 'hit' && m.v === wb.id && m.by === wa.id));
  check(hss && hss.gain === 4, `a shell in a ship scores 4 (+${hss && hss.gain})`);
  a.send({ t: 'fire', k: 3, sid: 42, x: SEA.x, y: NV.WATER_Y, z: SEA.z, vx: 22, vy: 0, vz: 0 });
  const ft = await b.next(m => m.t === 'fire' && m.id === wa.id && m.sid === 42);
  check(ft && ft.k === 3 && ft.vx === 22, 'B gets A\'s torpedo');
  b.send({ t: 'hit', by: wa.id, sid: 42, kill: true });
  const htp = ptsNow(await a.next(m => m.t === 'hit' && m.v === wb.id && m.by === wa.id));
  check(htp && htp.gain === 15 && htp.kill === true, `a torpedo in a ship scores 15, and its kill is passed on (+${htp && htp.gain})`);
  a.send({ t: 'fire', k: 3, sid: 43, x: SEA.x, y: 10, z: SEA.z, vx: 22, vy: 0, vz: 0 });
  a.send({ t: 'fire', k: 3, sid: 44, x: SEA.x, y: NV.WATER_Y, z: SEA.z, vx: 60, vy: 0, vz: 0 });
  a.send({ t: 'fire', k: 2, sid: 45, x: SEA.x, y: NV.WATER_Y + 3, z: SEA.z, vx: 150, vy: 60, vz: 0 });
  check(!(await b.next(m => m.t === 'fire' && m.id === wa.id && m.sid >= 43 && m.sid <= 45, 500)), 'a torpedo off the water or too fast, or a shell too fast, is ignored');
  // a shell dropped on a bot (A is a ship): the server flies it as it flies the parcels, 1 point
  let sbot = null;
  for (let i = 0; i < 4 && !sbot; i++) {
    const s = a.last.get(bot1.id);
    if (!s) { await sleep(200); continue; }
    const [, x, z, h, v] = s, back = v * 0.15;
    a.send({ t: 'fire', k: 2, sid: 50 + i, x: x - Math.sin(h) * back, y: 1.0, z: z - Math.cos(h) * back, vx: 0, vy: 0, vz: 0 });
    sbot = ptsNow(await a.next(m => m.t === 'hit' && m.v === bot1.id && m.by === wa.id, 1000));
  }
  check(sbot && sbot.gain === 1, 'a ship\'s shell on a bot scores 1 point for A');
  // how long they can score: a torpedo runs 16 s and scores for 20 after its launch, a shell for 10 (both are reported 11 s later)
  a.send({ t: 'fire', k: 3, sid: 60, x: SEA.x, y: NV.WATER_Y, z: SEA.z, vx: 0, vy: 0, vz: 22 });
  a.send({ t: 'fire', k: 2, sid: 61, x: SEA.x, y: NV.WATER_Y + 3, z: SEA.z, vx: 70, vy: 30, vz: 70 });
  await b.next(m => m.t === 'fire' && m.id === wa.id && m.sid === 61);
  await sleep(11000);
  b.send({ t: 'hit', by: wa.id, sid: 61 });
  check(!(await a.next(m => m.t === 'hit' && m.v === wb.id && m.by === wa.id, 500)), 'a shell no longer scores 11 s after it was fired');
  b.send({ t: 'hit', by: wa.id, sid: 60 });
  const hlate = ptsNow(await a.next(m => m.t === 'hit' && m.v === wb.id && m.by === wa.id));
  check(hlate && hlate.gain === 15, 'a torpedo still scores 11 s after its launch (its run is 16 s)');
  b.send({ t: 'st', ct: 4, x: rb[1], z: rb[2], h: 0, v: 0, r: 0, s: 0 });   // B is a tank again

  // issue #16: the bots have been driving Karlín's street graph all along (B has watched them since they came in): for 30 s none of
  // them left the streets or stood still (at least 10 units in every 8 s: a dead end, the arena's edge or a tank in the way only turns
  // it back), and each got around (its places span 30 units or more)
  await sleep(Math.max(0, 30500 - (Date.now() - watchT)));
  const stuck = [];
  for (const p of botsA) {
    const L = (b.track.get(p.id) || []).filter(r => r[0] - watchT <= 30000), cum = [0];
    let minWin = Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, off = 0;
    for (let i = 1; i < L.length; i++) cum.push(cum[i - 1] + Math.hypot(L[i][1] - L[i - 1][1], L[i][2] - L[i - 1][2]));
    for (let i = 0, j = 0; i < L.length; i++) {
      while (j < L.length && L[j][0] - L[i][0] < 8000) j++;
      if (j < L.length) minWin = Math.min(minWin, cum[j] - cum[i]);
    }
    for (const [, x, z] of L) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); if (!onStreets(x, z)) off++; }
    const span = Math.hypot(x1 - x0, z1 - z0), path = cum[cum.length - 1];
    if (L.length < 400 || off || !(minWin >= 10) || !(span >= 30)) stuck.push(`${p.name}: ${L.length} rows, ${off} off the streets, ${minWin.toFixed(0)} units in the slowest 8 s, span ${span.toFixed(0)}`);
    else console.log(`     ${p.name}: ${path.toFixed(0)} units in 30 s, at least ${minWin.toFixed(0)} in every 8 s, over ${span.toFixed(0)} units of Karlín`);
  }
  check(!stuck.length, 'every bot follows the street graph for 30 s without getting stuck' + (stuck.length ? ' (' + stuck.join('; ') + ')' : ''));

  // A drops (pushing a car) and comes back from the same page (same key): the car goes back to the traffic, the points are still there
  const ptsA = shipPts ?? (hg ? hg.pts : hbot ? hbot.pts : 20);
  const [dx, dz, dh] = carAt(b.snap, 2);
  a.send({ t: 'st', ct: t0 + 900, x: dx, z: dz, h: 0, v: 0, r: 0, s: 0, c: [[2, dx, dz, dh, 1, 0]] });
  const held = await b.next(m => m.t === 'snap' && ownerOf(m, 2) === wa.id);
  a.ws.close();
  const lb = await b.next(m => m.t === 'leave' && m.id === wa.id);
  check(!!lb, 'B hears that A left');
  await sleep(150);
  check(held && !ownerOf(b.snap, 2), 'the car A was pushing goes back to the traffic');
  const a2 = client();
  await a2.opened;
  a2.send({ t: 'hello', name: 'Tester A', key: ka });
  const wa2 = await a2.next(m => m.t === 'welcome');
  check(wa2 && wa2.pts === ptsA, `A rejoins with the same key and keeps ${ptsA} points`);
  check(wa2 && wa2.props.some(p => p[0] === TREE && p[1] === 1), 'whoever comes in later finds the tree down');
  const a3 = client();
  await a3.opened;
  a3.send({ t: 'hello', name: 'Tester A', key: ka });
  const wa3 = await a3.next(m => m.t === 'welcome');
  check(wa3 && wa3.id === wa2.id && wa3.pts === ptsA, 'a second socket from the same page takes the player over');
  await a2.closed;

  // everybody leaves: the bots go too
  a3.ws.close(); b.ws.close();
  await Promise.all([a3.closed, b.closed]);
  await sleep(300);
  r = await fetch(BASE + '/health');
  const h2 = await r.json();
  check(h2.players === 0 && h2.bots === 0, 'with nobody left, the bots are gone');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
