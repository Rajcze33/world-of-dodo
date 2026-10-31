// Smoke test of a running World of DODO server: the static files and the whole protocol with two players
// and the bots. Expects the default of 3 bots (BOTS=3).
// Usage: node tools/smoke.js [http://localhost:3400]
'use strict';

const BASE = (process.argv[2] || 'http://localhost:3400').replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const BLUE = 0x4d8dff;
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
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'snap') for (const s of m.p) last.set(s[0], s);
    if (m.t === 'w') api.world = m;
    const i = waiters.findIndex(w => w.test(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else if (m.t !== 'snap' && m.t !== 'w') inbox.push(m);
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const closed = new Promise(res => { ws.onclose = e => res(e); });
  const api = {
    ws, opened, closed, last, world: null,
    send: m => ws.send(JSON.stringify(m)),
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
  r = await fetch(BASE + '/vendor/three.r128.min.js');
  check(r.status === 200 && r.headers.get('content-type').startsWith('text/javascript'), 'three.js is served');
  r = await fetch(BASE + '/fonts/Poppins-SemiBold.ttf');
  check(r.status === 200, 'fonts are served');
  r = await fetch(BASE + '/assets/logo-white.png');
  check(r.status === 200, 'the logo is served');
  r = await fetch(BASE + '/shared/site.js');
  check(r.status === 200 && (await r.text()).includes('WOD_SITE'), 'the construction site layout is served');
  r = await fetch(BASE + '/vendor/..%2f..%2fserver%2fserver.js');
  // 404 from this server; behind the Zerops balancer the request is refused with 400 before it gets here
  check(r.status === 404 || r.status === 400, `no way out of the client folder (${r.status})`);
  r = await fetch(BASE + '/package.json');
  check(r.status === 404, 'nothing outside the three asset folders');
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

  check(await refused({ name: 'tester a' }) === 'name_taken', 'a taken name is refused (case does not matter)');
  check(await refused({ name: ' ' + ZWSP + ' ' }) === 'name_invalid', 'an empty name is refused');
  check(await refused({ name: 'bot 7' }) === 'name_reserved', 'a bot\'s name is refused');

  a.send({ t: 'ping', c: 12345 });
  const pong = await a.next(m => m.t === 'pong');
  check(pong && pong.c === 12345, 'a ping gets its pong');

  // positions
  a.send({ t: 'st', x: 10.5, z: -20.25, h: 1.2, v: 12, r: 0, s: 1 });
  const snap = await b.next(m => m.t === 'snap' && m.p.some(s => s[0] === wa.id));
  const sa = snap && snap.p.find(s => s[0] === wa.id);
  check(sa && sa[1] === 10.5 && sa[2] === -20.25 && sa[6] === 1, 'B gets A\'s position (and the spawn shield) in a snapshot');
  a.send({ t: 'st', x: 9999, z: 0, h: 0, v: 0, r: 0 });
  const snap2 = await b.next(m => m.t === 'snap' && m.p.some(s => s[0] === wa.id && s[1] !== 10.5), 500);
  check(!snap2, 'a position outside the world is ignored');
  const bot1 = botsA[0], p0 = b.last.get(bot1.id);
  await sleep(1000);
  const p1 = b.last.get(bot1.id);
  check(p0 && p1 && Math.hypot(p1[1] - p0[1], p1[2] - p0[2]) > 3, 'BOT1 drives around the city');

  // the shared city: snapshots with the cars, the tram and the pedestrians; a knocked pedestrian falls for everyone
  const w = await b.next(m => m.t === 'w');
  check(w && w.c.length === 33 * 4 && w.p.length === 50 * 5 && typeof w.m === 'number', 'the shared city arrives: 33 cars, 50 pedestrians, the tram');
  const near = [...Array(50).keys()].sort((x, y) => Math.hypot(w.p[x * 5] - 10.5, w.p[x * 5 + 1] + 20.25) - Math.hypot(w.p[y * 5] - 10.5, w.p[y * 5 + 1] + 20.25))[0];
  a.send({ t: 'ped', i: near, vx: 6, vz: 0 });
  const fell = await b.next(m => m.t === 'w' && m.p[near * 5 + 3] > 0, 3000);
  check(!!fell, `pedestrian ${near}, hit by A, falls on B's screen too`);
  const lay = fell && b.world;
  await sleep(4000);
  const still = b.world && b.world.p[near * 5 + 3] > 1;
  const back = fell && await b.next(m => m.t === 'w' && m.p[near * 5 + 3] === 0, 15000);
  const moved = back && Math.hypot(back.p[near * 5] - lay.p[near * 5], back.p[near * 5 + 1] - lay.p[near * 5 + 1]);
  check(still && back && moved > 6, `she stays down a while, then walks again elsewhere (${moved ? moved.toFixed(0) : '?'} units away)`);
  a.send({ t: 'prop', i: 7, fx: 1, fz: 0 });
  const pb = await b.next(m => m.t === 'prop');
  check(pb && pb.i === 7 && pb.fx === 1 && !pb.up, 'a tree A knocked down falls for B');
  a.send({ t: 'prop', i: 7, fx: 0, fz: 1 });
  check(!(await b.next(m => m.t === 'prop', 500)), 'a tree that is down already is not knocked down again');

  // a parcel (straight up, off every street, so no bot can run into it), a hit, the points
  a.send({ t: 'fire', sid: 1, x: 10, y: 1.5, z: -17, vx: 0, vy: 4, vz: 0 });
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
  a.send({ t: 'fire', sid: 2, x: 10, y: 1.5, z: -17, vx: 0, vy: 4, vz: 0 });
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

  // A drops and comes back from the same page (same key): the points are still there
  const ptsA = hbot ? hbot.pts : 20;
  a.ws.close();
  const lb = await b.next(m => m.t === 'leave' && m.id === wa.id);
  check(!!lb, 'B hears that A left');
  const a2 = client();
  await a2.opened;
  a2.send({ t: 'hello', name: 'Tester A', key: ka });
  const wa2 = await a2.next(m => m.t === 'welcome');
  check(wa2 && wa2.pts === ptsA, `A rejoins with the same key and keeps ${ptsA} points`);
  check(wa2 && wa2.props.some(p => p[0] === 7 && p[1] === 1), 'whoever comes in later finds the tree down');
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
