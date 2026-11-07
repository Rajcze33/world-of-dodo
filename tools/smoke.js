// Smoke test of a running World of DODO server: the static files and the whole protocol with the players and the bots.
// Usage: node tools/smoke.js [http://localhost:3400]
// World of DODO, issue #16: the places come from the map of the real Karlín (client/shared/map.ts, loaded the way the server loads
// it, server/city.js; Node 24 runs the TypeScript), so run it against a server of the same version. Issue #20: the ships' places come
// from the river (client/shared/naval.ts).
// Issue #24: the team game (client/shared/rules.ts): two teams of TEAM_SIZE (read from what the first player finds), the objectives
// (zones, depots), the rounds. The test ends a round itself (A's team scores up to the round's points, obj.r.to), so run it against a
// server nobody else plays on; with ROUND_SEC under about 300 the round may end on its own in the middle of the test. It takes about
// two and a half minutes (a depot it destroys must come back after 90 s).
// Issue #26: Velemlok (client/shared/monster.ts, server/monster.js). The countdown is checked always; the rest needs a server that calls
// it soon and often (MON_FIRST_S=60 MON_EVERY_S=5 MON_LIFE_S=25: the test reads the timing from the server's obj.g and skips the rest
// when it would come later than MON_SOON s into the test). Then the test takes about three minutes.
'use strict';

const M = require('../server/city');
const NV = require('../client/shared/naval.ts');
const R = require('../client/shared/rules.ts');
const MS = require('../client/shared/monster.ts');

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
// and the depot) at least 8 units from any carriageway and from every supply depot (issue #24)
const OFF = (() => {
  for (const l of [...M.DATA.lots.slice(2), ...M.DATA.lots]) {
    const x = Math.round((l[0] + l[2]) / 2 * 100) / 100, z = Math.round((l[1] + l[3]) / 2 * 100) / 100, n = M.nearestEdge(x, z);
    if (n.d - n.e.w / 2 >= 8 && !M.solidAt(x, 1, z) && R.DEPOTS.every(d => Math.hypot(d.x - x, d.z - z) > 20)) return { x, z };
  }
  return { x: M.ARENA.x0 + 2, z: M.ARENA.z0 + 2 };
})();
// on the street graph: within a street's carriageway, give or take what a wall pushes a bot aside
const onStreets = (x, z) => { const n = M.nearestEdge(x, z); return !!n && n.d <= n.e.w / 2 + 2; };
// invisible characters a name must lose (built from code points, so none sits in this file)
const RLO = String.fromCharCode(0x202e), ZWSP = String.fromCharCode(0x200b);
// issue #26: Velemlok's part runs when it first comes at most this many seconds into the round
const MON_SOON = 120;
let failed = 0;

function check(ok, what) {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) failed++;
}

function client() {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiters = [];
  const last = new Map();                 // id -> the newest snapshot row of that vehicle
  const track = new Map();                // id -> [[ms, x, z, y, k, s], ...]: every row of the vehicles being watched (api.watch)
  const roster = new Map();               // id -> { id, name, bot, team, ... }: who is in, as this socket heard it (issue #24: with the teams)
  const ptsOf = new Map();                // id -> personal points as this socket heard them (hits, and issue #24's pts for zones and depots)
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') { roster.clear(); for (const p of m.players) { roster.set(p.id, { ...p }); ptsOf.set(p.id, p.pts || 0); } ptsOf.set(m.id, m.pts || 0); }
    else if (m.t === 'hit') ptsOf.set(m.by, m.pts);
    else if (m.t === 'pts') ptsOf.set(m.id, m.pts);
    else if (m.t === 'join') roster.set(m.p.id, { ...m.p });
    else if (m.t === 'leave') roster.delete(m.id);
    else if (m.t === 'team' && roster.has(m.id)) roster.get(m.id).team = m.team;
    if (m.t === 'snap') { for (const s of m.p) { last.set(s[0], s); track.get(s[0])?.push([Date.now(), s[1], s[2], s[9] || 0, s[8] || 0, s[6]]); } api.snap = m; }
    if (m.t === 'w') api.world = m;
    if (m.t === 'obj') api.obj = m;
    const i = waiters.findIndex(w => w.test(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else if (m.t !== 'snap' && m.t !== 'w' && m.t !== 'obj') { inbox.push(m); if (inbox.length > 4000) inbox.splice(0, 1000); }   // (the bots fire a lot)
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const closed = new Promise(res => { ws.onclose = e => res(e); });
  const api = {
    ptsOf: id => ptsOf.get(id) ?? 0,
    ws, opened, closed, last, track, roster, world: null, snap: null, obj: null,
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
const health = async () => (await fetch(BASE + '/health')).json();

async function refused(hello) {
  const c = client();
  await c.opened;
  c.send({ t: 'hello', key: key(), ...hello });
  const e = await c.next(m => m.t === 'err');
  await c.closed;
  return e && e.code;
}
// a person joining with team (0, 1, 'auto' or nothing): their welcome (and the socket in .c)
async function join(name, team) {
  const c = client();
  await c.opened;
  c.send({ t: 'hello', name, key: key(), ...(team === undefined ? {} : { team }) });
  const w = await c.next(m => m.t === 'welcome');
  return Object.assign(w || {}, { c });
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
  // World of DODO, issue #31: the page's script is the light entry (client/src/entry.ts): the join form works at once and the game
  // comes after it in stages (import()), Babylon.js and the map of Karlín among them. The map's marker is the first street name of
  // karlin.json that the texts do not hold (issue #16's check looked for the map's attribution, which client/src/texts.ts holds
  // too, so it never proved the map was in).
  const entry = await r.text();
  const texts = require('node:fs').readFileSync(require('node:path').join(__dirname, '../client/src/texts.ts'), 'utf8');
  const street = (M.EDGES.find(e => e.n && !texts.includes(e.n)) || {}).n;
  // the stages: every chunk the entry names, and every one they name, breadth first (a name that is not a chunk is a 404: skipped)
  const seen = new Set([app]), queue = [[app, entry]], chunks = [], body = new Map([[app, entry]]);
  while (queue.length && seen.size < 300) {
    const [, code] = queue.shift();
    for (const n of new Set(code.match(/[\w.-]+\.js/g) || [])) {
      const u = '/app/' + n; if (seen.has(u) || seen.size >= 300) continue;
      seen.add(u);
      const q = await fetch(BASE + u); if (q.status !== 200) continue;
      const b = await q.text(); body.set(u, b);
      chunks.push({ u, type: q.headers.get('content-type') || '', cache: q.headers.get('cache-control') || '', map: !!street && b.includes(street), bytes: Buffer.byteLength(b) });
      queue.push([u, b]);
    }
  }
  // what the page runs before its form works: the entry and what it imports statically (import ... from "./x.js", not import()),
  // which the browser must download and run first (a bundler may move a helper the entry needs into a big chunk)
  const first = new Set(), todo = [app];
  while (todo.length) {
    const u = todo.shift(); if (first.has(u) || !body.has(u)) continue; first.add(u);
    for (const m of body.get(u).matchAll(/(?:\bfrom\s*|\bimport\s*)["']\.\/([\w.-]+\.js)["']/g)) todo.push('/app/' + m[1]);
  }
  const firstCode = [...first].map(u => body.get(u)).join('\n'), firstKB = Buffer.byteLength(firstCode) / 1024;
  check(firstKB <= 60, `the page's script is the light entry (${(Buffer.byteLength(entry) / 1024).toFixed(1)} KB, ${first.size} file(s) with what it imports: ${firstKB.toFixed(1)} KB, at most 60)`);
  check(!!street && !firstCode.includes(street) && !firstCode.includes('WebGL not supported'), `the entry and what it imports carry neither the map ("${street}") nor Babylon.js`);
  check(chunks.length >= 2 && chunks.every(c => c.type.startsWith('text/javascript') && c.cache.includes('immutable')),
    `the game's stages are served as scripts that may be cached for good (${chunks.length} chunks, ${(chunks.reduce((a, c) => a + c.bytes, 0) / 1e6).toFixed(2)} MB)`);
  // issue #16: the page carries the map of Karlín (karlin.json, bundled by Vite)
  check(chunks.some(c => c.map), `a stage carries the map of Karlín (${(chunks.find(c => c.map) || {}).u})`);
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

  // issue #24: the places of the team game stand where the rules say (client/shared/rules.ts against the map): the ground zones on a
  // carriageway, the river zone on the water, every depot on open ground off the streets in its team's half, one of each team's
  // within a ship's shell range of the river
  const nav = []; for (let x = -700; x <= 700; x += 5) for (let z = -700; z <= 0; z += 5) if (NV.inWater(x, z, 6)) nav.push([x, z]);
  const riverD = d => Math.min(...nav.map(([x, z]) => Math.hypot(x - d.x, z - d.z)));
  check(R.ZONES.length === 4 && R.ZONES.slice(0, 3).every(q => !q.sea && M.onRoad(q.x, q.z) && M.freeAt(q.x, q.z, 3)) && R.ZONES[3].sea && NV.inWater(R.ZONES[3].x, R.ZONES[3].z, R.ZONES[3].r - 2),
    'the three ground zones are on Karlín\'s streets, the river zone on the Vltava');
  check(R.DEPOTS.length === 8 && R.DEPOTS.every((d, i) => d.i === i && d.team === (i < 4 ? 0 : 1) && R.homeSide(d.team, d.x) && M.freeAt(d.x, d.z, d.r + 1.5)
    && !M.onRoad(d.x, d.z) && R.ZONES.every(q => Math.hypot(q.x - d.x, q.z - d.z) > q.r + 30)) && [0, 1].every(t => R.DEPOTS.some(d => d.team === t && riverD(d) <= 125)),
    'the eight depots stand on open ground in their team\'s half, away from the zones, one of each team\'s within a shell\'s reach of the river');

  // two players, in the two teams (issue #24: hello asks for one)
  const a = client(), b = client();
  await Promise.all([a.opened, b.opened]);
  const ka = key(), kb = key();
  a.send({ t: 'hello', name: '  Tester' + RLO + ' A  ', color: BLUE, key: ka, team: 0 });
  const wa = await a.next(m => m.t === 'welcome');
  check(wa && wa.name === 'Tester A', 'A is welcomed, the name is cleaned (' + (wa && wa.name) + ')');
  check(wa && wa.color === BLUE && wa.pts === 0, 'A gets the colour A picked, and 0 points');
  check(wa && wa.team === 0, 'A is in team A, as asked');
  const g0 = wa && wa.game;
  check(g0 && g0.sc.join() === '0,0' && g0.z.length === 4 && g0.z.every(z => z[0] === -1 && z[1] === 0) && g0.d.length === 8 && g0.d.every(d => d[0] === R.DEPOT_HP && d[1] === 0)
    && g0.r.st === 'play' && g0.r.win === -1 && g0.r.left > 0 && g0.r.to > 0, `the welcome carries a fresh round: scores, neutral zones, depots standing (to ${g0 && g0.r.to} points, ${g0 && g0.r.left} s)`);
  // issue #26: and Velemlok, away, coming MON_FIRST_S into the round (the first person in started the round)
  const MON_FIRST = g0 && g0.g ? (g0.g.next - g0.ts) / 1000 : NaN, MON_ON = MON_FIRST <= MON_SOON;
  check(g0 && g0.g && g0.g.st === 0 && g0.g.hp === g0.g.max && g0.g.max > 0 && g0.g.dmg.join() === '0,0' && MON_FIRST >= 1,
    `the welcome carries Velemlok: away, ${g0 && g0.g && g0.g.max} hit points, it comes ${MON_FIRST} s into the round`);
  const bots0 = wa ? wa.players.filter(p => p.bot) : [], TS = (bots0.length + 1) / 2;
  check(Number.isInteger(TS) && TS >= 2 && bots0.filter(p => p.team === 0).length === TS - 1 && bots0.filter(p => p.team === 1).length === TS
    && bots0.map(p => p.name).sort().join() === bots0.map((p, i) => 'BOT' + (i + 1)).sort().join(),
    `the first player in finds the bots: ${TS - 1} in A and ${TS} in B (TEAM_SIZE ${TS}), BOT1 … BOT${bots0.length}`);
  b.send({ t: 'hello', name: 'Tester B', color: 0x123456, key: kb, team: 1 });
  const wb = await b.next(m => m.t === 'welcome');
  check(wb && wb.team === 1 && wb.players.some(p => p.id === wa.id && p.name === 'Tester A' && !p.bot && p.team === 0), 'B is welcomed in team B and sees A in team A');
  check(wb && wb.color !== 0x123456 && wb.color !== BLUE, 'a colour off the palette is replaced by a free one');
  const gone = await a.next(m => m.t === 'leave' && bots0.some(p => p.id === m.id));
  check(gone && bots0.find(p => p.id === gone.id).team === 1, 'a bot of team B makes room for B');
  const ja = await a.next(m => m.t === 'join' && !m.p.bot);
  check(ja && ja.p.id === wb.id && ja.p.team === 1, 'A hears that B joined team B');
  let hl = await health();
  check(hl.players === 2 && hl.bots === 2 * TS - 2, `/health counts 2 players and ${2 * TS - 2} bots (${JSON.stringify(hl)})`);

  // issue #24: a supply depot, hit by A's browser (thit): a parcel takes 2, a bullet 0.25; once per projectile, only the other team's
  // depot, only from near, only where it is; destroyed: 30 points for A's team, back 90 s later (checked at the end). (Done first: the
  // bots are still on their way.)
  const D = R.DEPOTS.filter(d => d.team === 1).sort((p, q) => Math.hypot(HOME.x - p.x, HOME.z - p.z) - Math.hypot(HOME.x - q.x, HOME.z - q.z))[0];
  const OWN = R.DEPOTS.find(d => d.team === 0);
  const hpOf = o => o && o.d[D.i][0];
  const objAfter = async (ms = 400) => { await sleep(ms); return a.obj; };
  a.send({ t: 'st', ct: 1, x: D.x + 9, z: D.z, h: 0, v: 0, r: 0, s: 0 });
  await sleep(100);
  const fireAt = (sid, k = 0) => a.send({ t: 'fire', sid, x: D.x + 6, y: 1.5, z: D.z, vx: -10, vy: 4, vz: 0, ...(k ? { k } : {}) });
  const thitD = (sid, k = 0, dx = 1, i = D.i) => a.send({ t: 'thit', i, k, x: (i === D.i ? D.x : OWN.x) + dx, y: D.y + 0.5, z: i === D.i ? D.z : OWN.z, sid });
  fireAt(70); await sleep(50); thitD(70);
  let o1 = await a.next(m => m.t === 'obj' && m.d[D.i][0] < R.DEPOT_HP, 1500);
  check(o1 && hpOf(o1) === R.DEPOT_HP - 2 && o1.d[D.i][1] === 0, `a parcel on B's depot ${D.i} takes 2 (${hpOf(o1)} left), the players hear it at once (obj)`);
  thitD(70);
  check(hpOf(await objAfter()) === R.DEPOT_HP - 2, 'the same parcel does not hit it twice');
  fireAt(71); await sleep(50); thitD(71, 0, 0, OWN.i);
  check((await objAfter()).d[OWN.i][0] === R.DEPOT_HP, 'a team cannot damage its own depot');
  fireAt(72); await sleep(50); thitD(72, 0, 25);
  check(hpOf(await objAfter()) === R.DEPOT_HP - 2, 'a hit claimed off the depot does not count');
  a.send({ t: 'st', ct: 2, x: D.x + 300, z: D.z, h: 0, v: 0, r: 0, s: 0 });
  await sleep(100); fireAt(73); await sleep(50); thitD(73);
  check(hpOf(await objAfter()) === R.DEPOT_HP - 2, 'nor one from a shooter 300 units away');
  a.send({ t: 'st', ct: 3, x: D.x + 9, z: D.z, h: 0, v: 0, r: 0, s: 0 });
  await sleep(100); fireAt(74, 1); await sleep(50); thitD(74, 1);
  check(hpOf(await objAfter()) === R.DEPOT_HP - 2.25, 'a bullet takes 0.25');
  const sc0 = a.obj.sc[0];
  fireAt(75); fireAt(76); await sleep(50); thitD(75); thitD(76, 0, -1);
  const od = await a.next(m => m.t === 'obj' && m.d[D.i][0] === 0, 1500);
  const killedAt = Date.now();
  check(od && od.d[D.i][1] > od.ts + 88000 && od.d[D.i][1] < od.ts + 91000 && od.sc[0] >= sc0 + R.DEPOT_PTS,
    `two more parcels destroy it: ${R.DEPOT_PTS} points for team A (${sc0} -> ${od && od.sc[0]}), rebuilt in 90 s (${od && od.d[D.i][1] - od.ts} ms)`);

  // issue #24: the teams. A person asking for a team gets it unless it has 2 or more people more than the other; auto: the team with
  // fewer people. H1 and H2 stay for the whole test (A's teammates).
  const h1 = await join('Helper One', 0), h2 = await join('Helper Two', 0);
  const c3 = await join('Tester C', 0), c4 = await join('Tester D', 'auto'), c5 = await join('Tester E', 1), c6 = await join('Tester F');
  check(h1.team === 0 && h2.team === 0 && c3.team === 1 && c4.team === 1 && c5.team === 1 && c6.team === 0,
    `teams: asked A, A (granted), asked A with A 2 ahead (B instead), auto (B, fewer), asked B, auto (A): ${[h1, h2, c3, c4, c5, c6].map(w => w.team).join(', ')}`);
  hl = await health();
  check(hl.players === 8 && hl.bots === 2 * Math.max(0, TS - 4), `each person took a bot's place: 8 players, ${2 * Math.max(0, TS - 4)} bots (${JSON.stringify(hl)})`);
  for (const w of [c3, c4, c5, c6]) w.c.ws.close();
  await Promise.all([c3, c4, c5, c6].map(w => w.c.closed));
  await sleep(300);
  hl = await health();
  check(hl.players === 4 && hl.bots === 2 * TS - 4, `when they leave, bots take their places again (${JSON.stringify(hl)})`);

  // the bots' vehicles: each team flies a plane and sails a ship (no person of it does), the rest drive tanks
  let RO = a.roster;                                    // who is who (the bots' teams), as A's socket heard it
  const botTeam = { get: id => RO.get(id) && RO.get(id).bot ? RO.get(id).team : undefined, has: id => !!(RO.get(id) && RO.get(id).bot) };
  const sk = await b.next(m => m.t === 'snap' && m.p.filter(s => botTeam.has(s[0])).length === 2 * TS - 4, 3000);
  const rows = sk ? sk.p.filter(s => botTeam.has(s[0])) : [];
  const per = t => rows.filter(s => botTeam.get(s[0]) === t);
  check(rows.length === 2 * TS - 4 && [0, 1].every(t => per(t).length < 2 || (per(t).filter(s => s[8] === 1).length === 1 && per(t).filter(s => s[8] === 2).length === 1 && per(t).filter(s => !s[8]).length === per(t).length - 2)),
    `each team's bots: a plane, a ship, the rest tanks (A ${per(0).map(s => s[8] || 0).join('')}, B ${per(1).map(s => s[8] || 0).join('')})`);
  const tanks0 = rows.filter(s => !s[8]);
  check(tanks0.length > 0 && tanks0.every(s => onStreets(s[1], s[2]) && M.inArena(s[1], s[2])), `the tank bots are on the streets (${tanks0.map(s => s[1].toFixed(0) + ',' + s[2].toFixed(0)).join('; ')})`);
  check(rows.filter(s => s[8] === 1).every(s => s.length === 11 && s[9] > M.terrainH(s[1], s[2]) + 10) && rows.filter(s => s[8] === 2).every(s => s.length === 13 && NV.bankDist(s[1], s[2]) > 0),
    'the plane bots are in the air, the ship bots on the river, in the rows a player\'s plane and ship send');
  for (const s of rows) b.watch(s[0]);                  // and they are watched from now on (checked below)
  const watchT = Date.now();
  const foe = tanks0.find(s => botTeam.get(s[0]) === 1), mate = tanks0.find(s => botTeam.get(s[0]) === 0);
  const foeId = foe[0];

  check(await refused({ name: 'tester a' }) === 'name_taken', 'a taken name is refused (case does not matter)');
  check(await refused({ name: ' ' + ZWSP + ' ' }) === 'name_invalid', 'an empty name is refused');
  check(await refused({ name: 'bot 7' }) === 'name_reserved', 'a bot\'s name is refused');

  a.send({ t: 'ping', c: 12345 });
  const pong = await a.next(m => m.t === 'pong');
  check(pong && pong.c === 12345, 'a ping gets its pong');
  // issue #24: the objectives come once a second (and at once on a change)
  const objs = []; for (let i = 0; i < 3; i++) objs.push(await a.next(m => m.t === 'obj', 1600));
  check(objs.every(o => o && Array.isArray(o.sc) && o.z.length === 4 && o.d.length === 8 && o.r) && objs[2].ts - objs[0].ts <= 2200,
    `the objectives (obj) come at least once a second (${objs.map(o => o && o.ts).join(', ')})`);

  // positions, each stamped with the moment it shows on the server's clock (from the browser's own clock, ct)
  const t0 = Math.round(performance.now());
  a.send({ t: 'st', ct: t0, x: HOME.x, z: HOME.z, h: 1.2, v: 12, r: 0, s: 1 });
  const snap = await b.next(m => m.t === 'snap' && m.p.some(s => s[0] === wa.id && s[1] === HOME.x));
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
  const p0 = b.last.get(foeId);
  await sleep(1500);                                               // (1.5 s: it may be turning round at a dead end, issue #16)
  const p1 = b.last.get(foeId);
  check(p0 && p1 && (Math.hypot(p1[1] - p0[1], p1[2] - p0[2]) > 3 || R.zoneAt(p1[1], p1[2], false) >= 0 || p1[6] === 2), 'a tank bot drives around the city (or holds a zone)');

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

  // a parcel (straight up, off every street, so no bot can run into it), a hit, the points (A and B are in different teams)
  a.send({ t: 'fire', sid: 1, x: OFF.x, y: 1.5, z: OFF.z, vx: 0, vy: 4, vz: 0 });
  const fb = await b.next(m => m.t === 'fire' && m.id === wa.id && m.sid === 1);
  check(fb && fb.sid === 1 && fb.vy === 4, 'B gets A\'s parcel');
  const scA = a.obj.sc[0];
  b.send({ t: 'hit', by: wa.id, sid: 1 });
  const [ha, hb] = await Promise.all([a.next(m => m.t === 'hit' && m.v === wb.id), b.next(m => m.t === 'hit' && m.v === wb.id)]);
  check(ha && ha.by === wa.id && ha.gain === 10 && ha.pts >= 10 && !ha.kill && hb && hb.pts === ha.pts, 'a hit on a player scores 10 for A, both hear it');
  const oh = await a.next(m => m.t === 'obj' && m.sc[0] >= scA + 10, 1500);
  check(!!oh, `and 10 for A's team (${scA} -> ${oh && oh.sc[0]})`);
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
  check(hk && hk.kill === true && hk.gain === 10, 'the hit that destroys B is passed on as a kill');

  // issue #24: friendly fire is off. H1 (A's teammate) reporting A's parcel scores nothing, A's bullet on H1 is not passed on
  h1.c.send({ t: 'st', ct: 1, x: OFF.x, z: OFF.z + 3, h: 0, v: 0, r: 0, s: 0 });
  a.send({ t: 'fire', sid: 3, x: OFF.x, y: 1.5, z: OFF.z, vx: 0, vy: 4, vz: 0 });
  await h1.c.next(m => m.t === 'fire' && m.id === wa.id && m.sid === 3);
  h1.c.send({ t: 'hit', by: wa.id, sid: 3, kill: true });
  check(!(await a.next(m => m.t === 'hit' && m.v === h1.id, 600)), 'a hit on a teammate scores nothing');
  a.send({ t: 'fire', k: 1, sid: 4, x: OFF.x, y: 2, z: OFF.z, vx: 0, vy: 0, vz: 170 });
  a.send({ t: 'shot', v: h1.id, sid: 4 });
  check(!(await h1.c.next(m => m.t === 'dmg', 600)), 'a teammate\'s bullet is not passed on');

  // a parcel dropped onto a bot: the server flies it, 5 points (issue #24: half a person's, at least 1) for a bot of the other team, and
  // nothing for a teammate's
  let hbot = null;
  for (let i = 0; i < 6 && !hbot; i++) {
    const s = a.last.get(foeId);
    if (!s || s[6]) { await sleep(400); continue; }
    const [, x, z, h, v] = s, back = v * 0.15;                // the server tests against where the bot was 200 ms ago
    a.send({ t: 'fire', sid: 10 + i, x: x - Math.sin(h) * back, y: 1.0, z: z - Math.cos(h) * back, vx: 0, vy: 0, vz: 0 });
    hbot = await a.next(m => m.t === 'hit' && m.v === foeId && m.by === wa.id, 1000);
  }
  check(hbot && hbot.gain === 5, `a parcel on a bot of the other team scores 5 points for A (${hbot && hbot.gain})`);
  let hmate = null;
  for (let i = 0; i < 3 && mate && !hmate; i++) {
    const s = a.last.get(mate[0]);
    if (!s) { await sleep(200); continue; }
    const [, x, z, h, v] = s, back = v * 0.15;
    a.send({ t: 'fire', sid: 16 + i, x: x - Math.sin(h) * back, y: 1.0, z: z - Math.cos(h) * back, vx: 0, vy: 0, vz: 0 });
    hmate = await a.next(m => m.t === 'hit' && m.v === mate[0] && m.by === wa.id, 800);
  }
  check(!!mate && !hmate, 'a parcel on a bot of A\'s own team scores nothing');

  // planes (issue #14): a plane's row carries its kind, height and pitch; a bullet's shooter reports its hit (shot), the victim gets it
  // passed on (dmg) and answers like a parcel hit: 3 points for a bullet in a tank, 5 in a plane; a bot fires at a low enemy plane
  while (await a.next(m => m.t === 'hit' && (m.by === wa.id || m.v === wa.id), 100));   // (hits A heard earlier and no check took: not these)
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
  const hg = await a.next(m => m.t === 'hit' && m.v === wb.id && m.by === wa.id);
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
  const foeTanks = () => [...a.last.values()].filter(s => botTeam.get(s[0]) === 1 && !s[8] && !s[6]);
  for (let i = 0; i < 25 && !flak; i++) {
    const s = foeTanks()[i % Math.max(1, foeTanks().length)];
    if (!s) { await sleep(200); continue; }
    a.send({ t: 'st', ct: t0 + 510 + i, x: s[1], z: s[2], h: 0, v: 20, r: 0, s: 0, k: 1, y: 30, p: 0 });   // right above the bot
    flak = await a.next(m => m.t === 'fire' && m.k === 1 && botTeam.get(m.id) === 1 && !(a.last.get(m.id) || [])[8], 300);
  }
  check(!!flak, 'a tank bot of the other team fires at a low plane above it');

  // issue #20: ships. A ship's row (k 2) carries its heave and sinking, its pitch and its turrets' yaw, and counts only on the river;
  // only a ship fires shells (k 2) and torpedoes (k 3); the victim reports their hits as for a parcel: a shell scores 10 in a tank and
  // 4 in a ship, a torpedo 15; a shell dropped on a bot is flown by the server (5 points). The ships go to the river's spawn points
  // farthest from the arena.
  const outside = p => Math.hypot(Math.max(M.ARENA.x0 - p.x, 0, p.x - M.ARENA.x1), Math.max(M.ARENA.z0 - p.z, 0, p.z - M.ARENA.z1));
  const [SEA, SEA2] = [...NV.SHIP_SPAWNS].sort((p, q) => outside(q) - outside(p));
  let shipPts = null;
  const ptsNow = m => { if (m && m.by === wa.id) shipPts = m.pts; return m; };
  while (await a.next(m => m.t === 'hit' && (m.by === wa.id || m.v === wa.id), 200));   // (hits A heard earlier and no check took: not these)
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
  // a shell dropped on a bot of the other team (A is a ship): the server flies it as it flies the parcels, 5 points
  let sbot = null;
  for (let i = 0; i < 6 && !sbot; i++) {
    const s = a.last.get(foeId);
    if (!s || s[6]) { await sleep(400); continue; }
    const [, x, z, h, v] = s, back = v * 0.15;
    a.send({ t: 'fire', k: 2, sid: 50 + i, x: x - Math.sin(h) * back, y: 1.0, z: z - Math.cos(h) * back, vx: 0, vy: 0, vz: 0 });
    sbot = ptsNow(await a.next(m => m.t === 'hit' && m.v === foeId && m.by === wa.id, 1000));
  }
  check(sbot && sbot.gain === 5, `a ship's shell on a bot of the other team scores 5 points for A (${sbot && sbot.gain})`);
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

  // issue #24: the zones. A and her two teammates (H1, H2: at most 3 of a team count) drive into the ground zone with the fewest tanks of
  // team B about: team A takes it, and it gives A a point every second; then they sail into the river zone as ships and take it too
  const helpers = [a, h1.c, h2.c];
  const foeNear = q => [...a.last.values()].filter(s => botTeam.get(s[0]) === 1 && !s[8] && s[6] !== 2 && Math.hypot(s[1] - q.x, s[2] - q.z) < q.r + 60).length;
  const G = R.ZONES.filter(q => !q.sea).sort((p, q) => foeNear(p) - foeNear(q))[0];
  const holdIn = async (q, ship, ms) => {
    const until = Date.now() + ms;
    let o = null;
    for (let n = 0; Date.now() < until; n++) {
      helpers.forEach((c, i) => {
        const x = q.x + (i - 1) * 3, z = q.z + (ship ? (i - 1) * 6 : 0);
        c.send(ship ? { t: 'st', ct: 10 + n, x, z, h: 1.57, v: 2, r: 0, s: 0, k: 2, y: 0, p: 0, a: [0, 3.14] } : { t: 'st', ct: 10 + n, x, z, h: 0, v: 0, r: 0, s: 0 });
      });
      o = a.obj;
      if (o && o.z[q.i][0] === 0 && o.z[q.i][1] === 100) return o;
      await sleep(200);
    }
    return null;
  };
  const before = a.obj.z[G.i];
  const tz0 = Date.now(), oz = await holdIn(G, false, 25000);
  check(!!oz, `three tanks of A take the ground zone ${G.name} (from ${before}; ${((Date.now() - tz0) / 1000).toFixed(1)} s)`);
  const cp = await a.next(m => m.t === 'pts' && m.gain === R.CAP_PTS, 2000);
  check(!!cp, `the tanks that took it get ${R.CAP_PTS} points each (pts)`);
  const o2a = await a.next(m => m.t === 'obj', 1500);
  await sleep(3200);
  const o2b = a.obj, ownA = o2a.z.map((z, i) => z[0] === 0 && o2b.z[i][0] === 0 ? 1 : 0).reduce((s, v) => s + v, 0), secs = Math.floor((o2b.ts - o2a.ts) / 1000);
  check(ownA >= 1 && o2b.sc[0] - o2a.sc[0] >= ownA * (secs - 1), `an owned zone gives its team a point a second (A owns ${ownA}: +${o2b.sc[0] - o2a.sc[0]} in ${secs} s)`);
  const RZ = R.ZONES[3], tz1 = Date.now(), or = await holdIn(RZ, true, 30000);
  check(!!or, `three ships of A take the river zone (${((Date.now() - tz1) / 1000).toFixed(1)} s)`);
  for (const c of helpers) c.send({ t: 'st', ct: 900, x: HOME.x, z: HOME.z, h: 0, v: 0, r: 0, s: 0 });
  h1.c.send({ t: 'st', ct: 901, x: OFF.x, z: OFF.z, h: 0, v: 0, r: 0, s: 0 }); h2.c.send({ t: 'st', ct: 901, x: OFF.x + 4, z: OFF.z, h: 0, v: 0, r: 0, s: 0 });

  // issue #16: the tank bots have been driving Karlín's street graph all along (B has watched them since they came in): for 30 s none of
  // them left the streets or stood still (at least 10 units in every 8 s: a dead end, the arena's edge or a tank in the way only turns
  // it back), unless it held a zone (issue #24: a tank bot stops in a zone while it captures it) or lay destroyed. Issue #24: the plane
  // bots flew (in the air, over the ground, far), the ship bots sailed (on the water, and got about)
  await sleep(Math.max(0, 30500 - (Date.now() - watchT)));
  const stuck = [];
  for (const id of b.track.keys()) {
    const L = (b.track.get(id) || []).filter(r => r[0] - watchT <= 30000), name = 'BOT#' + id, k = L.length ? L[0][4] : 0, cum = [0];
    for (let i = 1; i < L.length; i++) cum.push(cum[i - 1] + Math.hypot(L[i][1] - L[i - 1][1], L[i][2] - L[i - 1][2]));
    const path = cum[cum.length - 1];
    if (L.length < 400 || L.some(r => r[4] !== k)) { if (L.length < 400) stuck.push(`${name}: ${L.length} rows`); continue; }
    if (k === 1) {
      const low = L.filter(r => r[5] !== 2 && r[3] < M.terrainH(r[1], r[2]) + 2).length;
      if (low || path < 300) stuck.push(`${name} (plane): ${low} rows on the ground, ${path.toFixed(0)} units`);
      else console.log(`     ${name} (plane): ${path.toFixed(0)} units in 30 s, never under 2 over the ground`);
      continue;
    }
    if (k === 2) {
      const dry = L.filter(r => NV.bankDist(r[1], r[2]) < -0.5).length;
      if (dry || path < 40) stuck.push(`${name} (ship): ${dry} rows off the water, ${path.toFixed(0)} units`);
      else console.log(`     ${name} (ship): ${path.toFixed(0)} units in 30 s on the river`);
      continue;
    }
    let minWin = Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, off = 0;
    for (let i = 0, j = 0; i < L.length; i++) {
      while (j < L.length && L[j][0] - L[i][0] < 8000) j++;
      if (j >= L.length) break;
      const held = L.slice(i, j).some(r => r[5] === 2 || R.zoneAt(r[1], r[2], false) >= 0);
      if (!held) minWin = Math.min(minWin, cum[j] - cum[i]);
    }
    for (const [, x, z] of L) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); if (!onStreets(x, z)) off++; }
    const span = Math.hypot(x1 - x0, z1 - z0);
    if (off || !(minWin >= 10) || !(span >= 30)) stuck.push(`${name}: ${off} rows off the streets, ${minWin.toFixed(0)} units in the slowest 8 s outside a zone, span ${span.toFixed(0)}`);
    else console.log(`     ${name} (tank): ${path.toFixed(0)} units in 30 s, at least ${minWin === Infinity ? '-' : minWin.toFixed(0)} in every 8 s outside a zone, over ${span.toFixed(0)} units of Karlín`);
  }
  check(!stuck.length, 'for 30 s the tank bots follow the street graph without getting stuck, the plane bots fly, the ship bots sail' + (stuck.length ? ' (' + stuck.join('; ') + ')' : ''));
  hl = await health();
  check(hl.tick && hl.tick.avg < 20, `the server's tick takes ${hl.tick && hl.tick.avg} ms on average (${hl.tick && hl.tick.max} at most, processor ${hl.tick && hl.tick.cpu}) with ${hl.bots} bots`);

  // A drops (pushing a car) and comes back from the same page (same key): the car goes back to the traffic, the points are still there,
  // and she is in her team again
  const [dx, dz, dh] = carAt(b.snap, 2);
  a.send({ t: 'st', ct: t0 + 900, x: dx, z: dz, h: 0, v: 0, r: 0, s: 0, c: [[2, dx, dz, dh, 1, 0]] });
  const held = await b.next(m => m.t === 'snap' && ownerOf(m, 2) === wa.id);
  a.ws.close();
  const lb = await b.next(m => m.t === 'leave' && m.id === wa.id);
  check(!!lb, 'B hears that A left');
  const ptsA = b.ptsOf(wa.id);           // (issue #24: with what A's tank earned in a zone, pts messages)
  await sleep(150);
  check(held && !ownerOf(b.snap, 2), 'the car A was pushing goes back to the traffic');
  const a2 = client();
  await a2.opened;
  a2.send({ t: 'hello', name: 'Tester A', key: ka });
  const wa2 = await a2.next(m => m.t === 'welcome');
  check(wa2 && wa2.pts === ptsA && wa2.team === 0, `A rejoins with the same key and keeps ${ptsA} points and her team`);
  check(wa2 && wa2.props.some(p => p[0] === TREE && p[1] === 1), 'whoever comes in later finds the tree down');
  const a3 = client();
  await a3.opened;
  a3.send({ t: 'hello', name: 'Tester A', key: ka });
  const wa3 = await a3.next(m => m.t === 'welcome');
  check(wa3 && wa3.id === wa2.id && wa3.pts === ptsA && wa3.team === 0, 'a second socket from the same page takes the player over');
  await a2.closed;
  const A = a3, aId = wa3.id;
  A.send({ t: 'st', ct: 1, x: OFF.x - 4, z: OFF.z, h: 0, v: 0, r: 0, s: 0 });

  // the depot destroyed at the start is back 90 s later
  await sleep(Math.max(0, 91500 - (Date.now() - killedAt)));
  const ob = await A.next(m => m.t === 'obj', 1500);
  check(ob && ob.d[D.i][0] === R.DEPOT_HP && ob.d[D.i][1] === 0, `B's depot ${D.i} is rebuilt 90 s after it was destroyed`);

  // issue #26: Velemlok. Both teams fight it: A (a ship) torpedoes it and reports her hits (mhit), only the valid ones count; it turns on
  // whoever hurt it most lately; B kills it: the team with more damage gets the bonus, everyone who hurt it their personal points, and
  // obj.g.next says when it comes and goes. Then it comes again, B (a low plane) bombs it and draws a geyser, and it flees. (Its numbers
  // are client/shared/monster.ts's, its timing the server's: read from obj.g.)
  const monPose = g => ({ x: g[0], z: g[1], h: g[2], y: g[3], rear: g[6] });
  const objG = (test, ms) => A.next(m => m.t === 'obj' && test(m.g, m), ms);
  const sOf = () => (A.snap ? A.snap.ts : 0);
  // a spot on the water a ship fits in, between lo and hi from its body at pose P (the nearest to lo)
  const waterNear = (P, lo, hi) => {
    let best = null, bd = Infinity;
    for (let dx = -150; dx <= 150; dx += 4) for (let dz = -150; dz <= 150; dz += 4) {
      const x = P.x + dx, z = P.z + dz; if (!NV.inWater(x, z, 7)) continue;
      const d = MS.monDist(P, x, z); if (d >= lo && d <= hi && d - lo < bd) { bd = d - lo; best = { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 }; }
    }
    return best;
  };
  const shipAt = (c, p, n) => c.send({ t: 'st', ct: 20000 + n, x: p.x, z: p.z, h: 0, v: 0, r: 0, s: 0, k: 2, y: 0, p: 0, a: [0, 3.14] });
  const torp = (c, sid, from, to) => {
    const dx = to.x - from.x, dz = to.z - from.z, l = Math.hypot(dx, dz) || 1;
    c.send({ t: 'fire', k: 3, sid, x: from.x, y: NV.WATER_Y, z: from.z, vx: Math.round(dx / l * 2200) / 100, vy: 0, vz: Math.round(dz / l * 2200) / 100 });
  };
  const mhit = (c, sid, k, at) => c.send({ t: 'mhit', k, sid, x: Math.round(at[0] * 100) / 100, y: Math.round(at[1] * 100) / 100, z: Math.round(at[2] * 100) / 100 });
  const ptsGain = (c, id, gain, ms = 2000) => c.next(m => m.t === 'pts' && m.id === id && m.gain === gain, ms);
  const drain = async (c, t) => { while (await c.next(m => m.t === t, 20)); };   // (what an earlier appearance left in the inbox)
  if (!MON_ON) console.log(`skip Velemlok's fight: it comes ${MON_FIRST} s into a round (start the server with MON_FIRST_S=60 MON_EVERY_S=5 MON_LIFE_S=25)`);
  else {
    const atks = [];                                     // every attack announced, as A heard it (with the server's time then)
    A.ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.t === 'mon') atks.push({ ...m, heard: sOf() }); });
    // out with at least 15 s to go, or surfacing: then the countdown to its leaving is checked
    let og = A.obj;
    if (!(og.g.st === 1 || og.g.st === 2 && og.g.next - og.ts > 15000)) og = await objG(g => g.st === 1, 120000);
    if (og && og.g.st === 1) {
      const life = (og.g.next - og.ts) / 1000;
      check(life >= 5 && og.g.hp === og.g.max, `Velemlok surfaces; obj.g says it leaves in ${life} s (MON_LIFE_S)`);
      og = await objG(g => g.st === 2, 8000);
    }
    const sg = A.snap && A.snap.g, ok1 = og && og.g.st === 2 && sg && sg.length === 7 && (sg[4] === 1 || sg[4] === 2) && NV.inWater(sg[0], sg[1], 0);
    check(ok1, `it is out: snap.g carries its pose on the river (${sg && sg.join(', ')}), obj.g its state (hp ${og && og.g.hp}, damage ${og && og.g.dmg.join(':')})`);
    if (ok1) {
      const P = monPose(A.snap.g), PA = waterNear(P, 60, 100), PB = waterNear(P, 6, 22), far = [...NV.SHIP_SPAWNS].sort((p, q) => Math.hypot(q.x - P.x, q.z - P.z) - Math.hypot(p.x - P.x, p.z - P.z))[0];
      check(!!PA && !!PB, `A sails 60-100 from its body (${PA && PA.x}, ${PA && PA.z}), B 6-22 (${PB && PB.x}, ${PB && PB.z})`);
      shipAt(A, PA, 1); shipAt(b, PB, 1);
      await sleep(150);
      // the hits A reports that must not count: a torpedo never fired, one fired but reported as a shell, one reported where it is not,
      // one reported from 500 away; then N valid ones (and one of them again): A's personal points must come to exactly N · 30 / 6
      const at = () => { const sp = MS.monSpheres(monPose(A.snap.g)); return [sp[1][0], sp[1][1], sp[1][2]]; };
      const dmg0 = A.obj.g.dmg[0], hp0 = A.obj.g.hp, N = Math.max(3, Math.min(10, Math.floor((hp0 - 150) / MS.MON_DMG.torp)));
      mhit(A, 5001, 3, at());
      torp(A, 5002, PA, P); await sleep(30); mhit(A, 5002, 2, at());
      torp(A, 5003, PA, P); await sleep(30); { const p = at(); mhit(A, 5003, 3, [p[0], p[1] + 30, p[2]]); }
      torp(A, 5004, PA, P); await sleep(30); shipAt(A, far, 2); await sleep(120); mhit(A, 5004, 3, at()); await sleep(60); shipAt(A, PA, 3); await sleep(120);
      for (let i = 0; i < N; i++) { torp(A, 5010 + i, PA, P); await sleep(25); mhit(A, 5010 + i, 3, at()); await sleep(25); }
      mhit(A, 5010, 3, at());
      const od1 = await objG(g => g.dmg[0] >= dmg0 + N * MS.MON_DMG.torp, 1500);
      check(!!od1, `A's ${N} torpedoes count for team A (damage ${dmg0} -> ${od1 && od1.g.dmg[0]}, hit points ${hp0} -> ${od1 && od1.g.hp})`);
      // it turns on A, the top threat now (B is nearer)
      const t1 = sOf(), na = atks.length;
      let onA = null; for (let i = 0; i < 40 && !onA; i++) { onA = atks.slice(na).find(m => m.v === aId); if (!onA) await sleep(200); }
      check(onA && (onA.a === 'jet' || onA.a === 'slam') && onA.at > onA.heard, `it defends itself: its next attack goes at A, who hurt it most (${onA && onA.a}, ${onA && ((onA.heard - t1) / 1000).toFixed(1)} s later, B nearer)`);
      const all = atks.every(m => ['slam', 'jet', 'geyser'].includes(m.a) && Number.isInteger(m.i) && m.r > 0 && Number.isFinite(m.x + m.y + m.z) && m.at > m.heard - 100);
      const jet = atks.find(m => m.a === 'jet'), land = jet && MS.monJetAt(jet, jet.at);
      check(all && atks.length > 0 && (!jet || (jet.t0 < jet.at && Math.hypot(land[0] - jet.x, land[1] - jet.y, land[2] - jet.z) < 1)),
        `its attacks are announced before they land (${atks.length}: ${[...new Set(atks.map(m => m.a))].join(', ')}${jet ? '; a jet lands where it says' : ''})`);
      // B finishes it off with torpedoes: the team with more damage gets MON_KILL_PTS, A her personal points for exactly her N hits
      const sc0 = A.obj.sc.slice();
      await drain(A, 'mres'); await drain(A, 'pts');
      const ptsA = ptsGain(A, aId, Math.round(N * MS.MON_DMG.torp / MS.MON_PTS_PER), 60000);
      let res = null; const resP = A.next(m => m.t === 'mres', 60000).then(m => { res = m; });
      for (let i = 0; i < 60 && !res; i++) {
        torp(b, 6001 + i, PB, monPose(A.snap.g)); await sleep(20);
        const sp = MS.monSpheres(monPose(A.snap.g)); mhit(b, 6001 + i, 3, [sp[1][0], sp[1][1], sp[1][2]]); await sleep(i % 8 === 7 ? 250 : 25);
      }
      await resP;
      const win = res ? (res.dmg[0] > res.dmg[1] ? 0 : res.dmg[1] > res.dmg[0] ? 1 : -1) : -2;
      check(res && res.killed === true && res.win === win && res.pts === (win < 0 ? 0 : MS.MON_KILL_PTS) && !res.end,
        `B kills it: mres says killed, damage ${res && res.dmg.join(':')}, the bonus ${res && res.pts} for team ${res && res.win}`);
      const osc = res && win >= 0 ? await A.next(m => m.t === 'obj' && m.sc[win] >= sc0[win] + MS.MON_KILL_PTS, 1500) : null;
      check(res && (win < 0 || !!osc), `the team that dealt more damage gets ${MS.MON_KILL_PTS} (${sc0.join(':')} -> ${osc ? osc.sc.join(':') : '-'})`);
      const pa = await ptsA, tb = res && res.top.find(e => e[0] === wb.id);
      const pb = tb ? await ptsGain(A, wb.id, Math.round(tb[1] / MS.MON_PTS_PER)) : null;
      check(!!pa && (!tb || !!pb), `personal points: A ${pa && pa.gain} for her ${N} valid hits (not the 5 refused), B ${pb ? pb.gain : '?'} (top ${res && JSON.stringify(res.top)})`);
      // it sinks; away, obj.g.next says when it comes again, and it does
      const gone = await objG(g => g.st === 0, (MS.MON_SINK_S + 3) * 1000);
      await sleep(200);
      check(!!gone && !(A.snap && A.snap.g), `it sinks and is gone (no snap.g); it comes again in ${gone && ((gone.g.next - gone.ts) / 1000).toFixed(1)} s (MON_EVERY_S)`);
      const up = gone && await objG(g => g.st === 1, gone.g.next - gone.ts + 3000);
      check(!!up && Math.abs(up.ts - gone.g.next) < 1200, `and it surfaces when obj.g said (${up && up.ts - (gone && gone.g.next)} ms off)`);
      // B, a plane low over it, bombs it (parcels, 9 each) and draws a geyser; it flees when obj.g said, B's team gets MON_FLEE_PTS
      const leaveAt = up && up.g.next, o2 = up && await objG(g => g.st === 2, 8000);
      if (o2) {
        const BP = monPose(A.snap.g), dmgB0 = A.obj.g.dmg[1], NB = 25;
        b.send({ t: 'st', ct: 30000, x: BP.x, z: BP.z, h: 0, v: 0, r: 0, s: 0, k: 1, y: 30, p: 0 });
        await sleep(150);
        const ptsB = ptsGain(A, wb.id, Math.round(NB * MS.MON_DMG.parcel / MS.MON_PTS_PER), 60000), nb = atks.length;
        for (let i = 0; i < NB; i++) {
          const sp = MS.monSpheres(monPose(A.snap.g));
          b.send({ t: 'fire', sid: 6200 + i, x: BP.x, y: 29, z: BP.z, vx: 0, vy: -5, vz: 0 }); await sleep(20);
          mhit(b, 6200 + i, 0, [sp[1][0], sp[1][1], sp[1][2]]); await sleep(i % 8 === 7 ? 250 : 25);
        }
        const od2 = await objG(g => g.dmg[1] >= dmgB0 + NB * MS.MON_DMG.parcel, 1500);
        check(!!od2, `B's ${NB} parcels from a plane count for team B (${dmgB0} -> ${od2 && od2.g.dmg[1]})`);
        let gey = null; for (let i = 0; i < 40 && !gey; i++) { gey = atks.slice(nb).find(m => m.v === wb.id); if (!gey) await sleep(200); }
        check(gey && gey.a === 'geyser' && gey.r === MS.MON_GEY_R && Math.hypot(gey.x - BP.x, gey.z - BP.z) < 30, `a geyser comes up under B's low plane (${gey && gey.a})`);
        await drain(A, 'mres');
        const sc2 = A.obj.sc.slice(), fled = await A.next(m => m.t === 'mres', leaveAt - sOf() + 4000), heard = sOf();
        const w2 = fled ? (fled.dmg[0] > fled.dmg[1] ? 0 : fled.dmg[1] > fled.dmg[0] ? 1 : -1) : -2;
        check(fled && fled.killed === false && fled.win === w2 && fled.pts === (w2 < 0 ? 0 : MS.MON_FLEE_PTS) && Math.abs(heard - leaveAt) < 1200,
          `it flees when obj.g said (${fled ? heard - leaveAt : '?'} ms off): damage ${fled && fled.dmg.join(':')}, ${fled && fled.pts} for team ${fled && fled.win}`);
        const osc2 = fled && w2 >= 0 ? await A.next(m => m.t === 'obj' && m.sc[w2] >= sc2[w2] + MS.MON_FLEE_PTS, 1500) : null;
        const pb2 = await ptsB;
        check(fled && (w2 < 0 || !!osc2) && !!pb2, `the bonus is in the team's score (${sc2.join(':')} -> ${osc2 ? osc2.sc.join(':') : '-'}), B gets ${pb2 && pb2.gain} personal points`);
      }
      b.send({ t: 'st', ct: 40000, x: rb[1], z: rb[2], h: 0, v: 0, r: 0, s: 0 });   // B is a tank again
      A.send({ t: 'st', ct: 40000, x: OFF.x - 4, z: OFF.z, h: 0, v: 0, r: 0, s: 0 });
      // (the round below ends while it is out: it comes again first)
      await objG(g => g.st === 1 || g.st === 2, 60000);
    }
  }

  // issue #24: the round. A's team scores up to the round's points (A's parcels on B): the round ends, team A wins, the best players are
  // named; in the intermission nothing is fired and nothing scores; INTER_S later a new round: scores, points, zones and depots reset, and
  // the teams evened out (A's team has 3 people, B's 1: the one of A's who came in last, A herself since she came back, goes over)
  RO = A.roster;
  const interG = [];                                     // issue #26: obj.g from the round's end to the next round
  A.ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.t === 'obj' && (m.r.st === 'end' || interG.length)) interG.push(m); });
  const outAtEnd = A.obj.g.st === 1 || A.obj.g.st === 2, mresEnd = A.next(m => m.t === 'mres' && m.end === 1, 60000);
  const o0 = await A.next(m => m.t === 'obj', 1500), to = o0.r.to;
  let sid = 1000, endObj = null;
  A.send({ t: 'fire', sid: 999, x: OFF.x, y: 1.5, z: OFF.z, vx: 0, vy: 4, vz: 0 });   // (reported only in the intermission)
  while (!endObj) {
    const need = Math.max(1, Math.ceil((to - A.obj.sc[0]) / 10)), n = Math.min(15, need), s0 = sid;
    for (let i = 0; i < n; i++) { sid++; A.send({ t: 'fire', sid, x: OFF.x, y: 1.5, z: OFF.z, vx: 0, vy: 4, vz: 0 }); }
    await sleep(40);
    for (let i = s0 + 1; i <= sid; i++) b.send({ t: 'hit', by: aId, sid: i });
    endObj = await A.next(m => m.t === 'obj' && m.r.st === 'end', 300);
    if (sid > 1000 + to) break;
  }
  check(endObj && endObj.r.win === 0 && endObj.sc[0] >= to && endObj.r.left <= R.INTER_S && endObj.r.left >= R.INTER_S - 1 && Array.isArray(endObj.r.best) && endObj.r.best.some(e => e[0] === aId),
    `a round ends when a team reaches ${to}: team A wins (${endObj && endObj.sc.join(':')}), the best players are named (${endObj && JSON.stringify(endObj.r.best)}), ${R.INTER_S} s of intermission`);
  A.send({ t: 'fire', sid: ++sid, x: OFF.x, y: 1.5, z: OFF.z, vx: 0, vy: 4, vz: 0 });
  check(!(await b.next(m => m.t === 'fire' && m.id === aId && m.sid === sid, 600)), 'in the intermission nothing is fired');
  while (await A.next(m => m.t === 'hit' && m.by === aId, 100));
  b.send({ t: 'hit', by: aId, sid: 999 });
  check(!(await A.next(m => m.t === 'hit' && m.by === aId, 600)), 'and nothing scores');
  const e1 = A.obj; await sleep(2200); const e2 = A.obj;
  check(e1.sc.join() === e2.sc.join() && e2.r.st === 'end', 'the scores stand still in the intermission');
  // issue #26: Velemlok: out at the round's end, it dives away with nothing for anyone (mres end); it does not come in the intermission,
  // and obj.g.next says it comes MON_FIRST_S after the next round starts
  if (outAtEnd) { const me = await mresEnd; check(me && me.pts === 0 && me.win === -1 && !me.killed, `the round's end sends Velemlok away unrewarded (${JSON.stringify(me)})`); }
  // (while it dives, obj.g.next is when it is gone; then, away, when it comes)
  const restart = endObj.ts + endObj.r.left * 1000, ge = A.obj.g.st === 0 ? A.obj.g : (await objG(g => g.st === 0, 8000) || A.obj).g;
  check(ge.st === 0 && Math.abs(ge.next - restart - MON_FIRST * 1000) <= 1500, `in the intermission obj.g.next says it comes ${MON_FIRST} s into the next round (${((ge.next - restart) / 1000).toFixed(1)})`);
  const tm = await A.next(m => m.t === 'team', (R.INTER_S + 4) * 1000);
  const nr = await A.next(m => m.t === 'obj' && m.r.st === 'play', 5000);
  check(tm && tm.id === aId && tm.team === 1, `the teams are evened out: the latest of A's three goes over to B (${JSON.stringify(tm)})`);
  check(nr && nr.sc[0] + nr.sc[1] <= 6 && nr.z.every(z => z[0] === -1 || Math.abs(z[1]) < 100) && nr.d.every(d => d[0] === R.DEPOT_HP) && nr.r.win === -1 && nr.r.left > 5,
    `then a new round: scores from nothing (${nr && nr.sc}), zones neutral, depots standing (${nr && nr.d.map(d => d[0]).join(',')})`);
  const inter = interG.filter(m => m.r.st === 'end');
  check(inter.length >= 5 && inter.every(m => m.g.st === 0 || m.g.st === 3) && nr && nr.g.st === 0 && Math.abs(nr.g.next - nr.ts - MON_FIRST * 1000) <= 1500,
    `Velemlok stays away in the intermission (${inter.length} obj, states ${[...new Set(inter.map(m => m.g.st))].join(',')}), the new round calls it in ${nr && ((nr.g.next - nr.ts) / 1000).toFixed(1)} s`);
  // A (now B's) hits H1 (A's): her points start again from nothing
  A.send({ t: 'fire', sid: ++sid, x: OFF.x, y: 1.5, z: OFF.z, vx: 0, vy: 4, vz: 0 });
  await h1.c.next(m => m.t === 'fire' && m.id === aId && m.sid === sid);
  h1.c.send({ t: 'hit', by: aId, sid });
  const hn = await A.next(m => m.t === 'hit' && m.by === aId && m.v === h1.id);
  check(hn && hn.pts === 10, `everyone's points start from nothing in the new round (A: ${hn && hn.pts})`);

  // everybody leaves: the bots go too
  A.ws.close(); b.ws.close(); h1.c.ws.close(); h2.c.ws.close();
  await Promise.all([A.closed, b.closed, h1.c.closed, h2.c.closed]);
  await sleep(300);
  const h2h = await health();
  check(h2h.players === 0 && h2h.bots === 0, 'with nobody left, the bots are gone');

  // World of DODO, issue #31: a page still loading after its welcome (textures, shaders: seconds, docs/PROTOCOL.md Limits) sends no
  // st. Meanwhile it is in (counted, its welcome and the snapshots come) but nowhere in snap.p, so nobody can hit it or see it; its
  // first st puts it there; when it gives up it closes its socket and is gone as a closed tab is.
  const L = client(); await L.opened;
  let snaps = 0, inSnap = false, lid = -1;
  L.ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.t === 'snap') { snaps++; if (m.p.some(s => s[0] === lid)) inSnap = true; } });
  L.send({ t: 'hello', name: 'Tester L', key: key(), team: 'auto' });
  const wl = await L.next(m => m.t === 'welcome'); lid = wl ? wl.id : -1; snaps = 0;
  await sleep(2500);
  const hl3 = await health();
  check(!!wl && snaps >= 30 && !inSnap && L.ws.readyState === 1 && hl3.players === 1,
    `a page still loading (welcomed, no st for 2.5 s) is in (/health: ${hl3.players} player, ${hl3.bots} bots) but in none of the ${snaps} snapshots`);
  L.send({ t: 'st', ct: 1, x: HOME.x, z: HOME.z, h: HOME.h || 0, v: 0, r: 0, s: 0 });
  const tl0 = Date.now();
  while (!inSnap && Date.now() - tl0 < 500) await sleep(10);
  check(inSnap, `its first st puts it into the snapshots (${Date.now() - tl0} ms)`);
  L.ws.close(); await L.closed; await sleep(300);
  const hl4 = await health();
  check(hl4.players === 0 && hl4.bots === 0, 'when it gives up and closes its socket, it is gone');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
