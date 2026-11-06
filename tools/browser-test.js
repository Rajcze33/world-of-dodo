// Browser test of World of DODO: two players in headless Chrome pick a name and a colour, start on a street of Karlín, see each
// other and the bots and the same city, a tank slides along a wall instead of sticking to it, a car one of them shoves
// is his for the other too, one shoots the other, the points show in both scoreboards, and a hit that destroys
// the tank brings it back somewhere else, then he takes a plane, flies, and the other's anti-aircraft gun hits it; then both take
// a ship on the Vltava (issue #20), one's shells hit the other's ship, and a hit 15 s old still counts towards sinking it.
// Issue #24, the teams: Rosta plays for A and Petr for B (each picks it in the join form); each sees the other in the other team's
// colour and the bots in both teams; a third player, Tereza, joins Rosta's team and her parcels do him no harm; Rosta's tank in a
// zone captures it in both players' HUDs; his parcels damage a depot of B in both players' views.
// Issue #26, Velemlok: Rosta's ship card counts down to the giant salamander; with a server that calls it soon (MON_FIRST_S=60
// MON_EVERY_S=5 MON_LIFE_S=90) it surfaces in both players' views and Rosta's shells hit it for team A (else that part is skipped).
// Saves screenshots for a look by eye.
// Needs Chrome and puppeteer-core, which is not a dependency of the game:
//   npm install --no-save puppeteer-core@25.14.0
//   node tools/browser-test.js [http://localhost:3400] [screenshot folder]
// (CHROME=path overrides the Chrome location.)
//
// Headless Chrome draws WebGL in software: a few frames a second, and the game caps a frame at 0.05 s of
// game time, so the game runs several times slower than real time. The test waits for states, not for time.
// The bots shoot too, so before each of Rosta's parcels the test clears Petr's own hit state.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');
const M = require('../server/city');               // issue #16: the map of the real Karlín (client/shared/map.ts), as the server loads it
const NV = require('../client/shared/naval.ts');   // issue #20: the Vltava (where a ship may be, which way the river runs)
const RU = require('../client/shared/rules.ts');   // issue #24: the teams, the zones, the depots
const MS = require('../client/shared/monster.ts'); // issue #26: Velemlok's numbers
// issue #26: Velemlok's fight is tested when it comes at most this many seconds after the test reaches it
const MON_SOON = 150;

// ---------- World of DODO, issue #16: real places in Karlín for the scenes below, found in the map ----------
const r2 = v => Math.round(v * 100) / 100;
// The duel: a straight stretch of a street (no tram, 12 units from the junctions, a clear view both ways), Rosta at one end facing
// Petr 26 units down it; the one nearest the middle of the city.
const DUEL = (() => {
  let best = null;
  for (const e of M.EDGES) {
    if (e.tram) continue;
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1], L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
      for (let t = 10; t + 36 <= L; t += 4) {
        const x0 = ax + ux * t, z0 = az + uz * t, x1 = x0 + ux * 26, z1 = z0 + uz * 26, d = Math.hypot(x0, z0);
        if (best && d >= best.d) continue;
        // issue #24: not by a ground zone, where the bots' tanks gather and would shove the two about
        if (RU.ZONES.some(q => !q.sea && Math.min(Math.hypot(x0 - q.x, z0 - q.z), Math.hypot(x1 - q.x, z1 - q.z)) < q.r + 30)) continue;
        if ([e.a, e.b].some(n => Math.min(Math.hypot(x0 - M.NODES[n].x, z0 - M.NODES[n].z), Math.hypot(x1 - M.NODES[n].x, z1 - M.NODES[n].z)) < 12)) continue;
        if (!M.onRoad(x0, z0, 1) || !M.onRoad(x1, z1, 1) || !M.freeAt(x0, z0, 2.5) || !M.freeAt(x1, z1, 2.5)) continue;
        if (M.segHit(x0, 1.5, z0, x1, 1.5, z1) < 1 || M.segHit(x0 - ux * 11.5, 5.4, z0 - uz * 11.5, x1, 1.3, z1) < 1 || M.segHit(x1 + ux * 11.5, 5.4, z1 + uz * 11.5, x0, 1.3, z0) < 1) continue;
        best = { ax: r2(x0), az: r2(z0), bx: r2(x1), bz: r2(z1), h: Math.atan2(ux, uz), d, name: e.n || '?' };
      }
    }
  }
  return best;
})();
// Street walls: straight runs of facades (one house or a row of them) at least 36 long along a street, with the pavement in front
// (so no parked car stands in the lane along them) and a clear way in from the street. a→b with the houses on the right, n the
// outward normal. The page then picks one without a tree or a lamp in the way (only it knows them).
const WALLS = (() => {
  const out = [];
  for (const s of M.SOLIDS) {
    if (s.far || s.y0 > 0.5 || s.site || s.kind === 'deck' || s.kind === 'pier' || s.h < 4) continue;
    for (let i = 0, p = s.p; i < p.length; i += 2) {
      const j = (i + 2) % p.length, ax = p[i], az = p[i + 1], L = Math.hypot(p[j] - ax, p[j + 1] - az); if (L < 8) continue;
      const ux = (p[j] - ax) / L, uz = (p[j + 1] - az) / L, nx = uz, nz = -ux;
      const ok = t => { const x = ax + ux * t, z = az + uz * t; return !!M.solidAt(x - nx * 0.3, 1, z - nz * 0.3) && M.freeAt(x + nx * 1.1, z + nz * 1.1, 1.0) && M.paved(x + nx * 2.3, z + nz * 2.3); };
      if (!ok(L / 2)) continue;
      let t0 = L / 2, t1 = L / 2; while (t0 > -60 && ok(t0 - 1)) t0--; while (t1 < L + 60 && ok(t1 + 1)) t1++;
      const tm = (t0 + t1) / 2, mx = ax + ux * tm, mz = az + uz * tm;
      if (t1 - t0 < 36 || !M.onRoad(mx + nx * 8, mz + nz * 8)) continue;
      let clear = true; for (let k = 2.6; k <= 8; k += 0.5) if (!M.freeAt(mx + nx * k, mz + nz * k, 1.0)) clear = false;
      if (clear && !out.some(w => Math.hypot(w.ax - ax - ux * t0, w.az - az - uz * t0) < 5)) out.push({ ax: ax + ux * t0, az: az + uz * t0, ux, uz, nx, nz, L: t1 - t0 });
    }
  }
  return out;
})();
// Out of sight: two of the map's spawn points 40 to 110 apart with houses between them, so that from anywhere round the first
// (where Rosta's camera may be) none of Petr's tank shows.
const HIDE = (() => {
  for (const A of M.SPAWNS) for (const B of M.SPAWNS) {
    const d = Math.hypot(A.x - B.x, A.z - B.z); if (d < 40 || d > 110) continue;
    let blocked = true;
    for (let a = 0; a < 12 && blocked; a++) for (const r of [0, 7, 14]) for (const y of [2, 6, 9]) {
      const cx = A.x + Math.sin(a * Math.PI / 6) * r, cz = A.z + Math.cos(a * Math.PI / 6) * r;
      if ([1.3, 2.6, 3.9].some(by => M.segHit(cx, y, cz, B.x, by, B.z) >= 1)) { blocked = false; break; }
    }
    if (blocked) return { ax: A.x, az: A.z, ah: A.h, bx: B.x, bz: B.z, bh: B.h };
  }
  return null;
})();
// Issue #24: for each of B's supply depots a place 18 in front of it for Rosta's tank, clear to the depot and behind it (for the camera),
// facing it: his parcels fly into it (the test takes one that stands)
const AT_DEPOT = RU.DEPOTS.filter(d => d.team === 1).map(d => {
  for (let a = 0; a < 360; a += 15) {
    const ux = Math.sin(a * Math.PI / 180), uz = Math.cos(a * Math.PI / 180), x = d.x + ux * 18, z = d.z + uz * 18;
    if (M.freeAt(x, z, 2.5) && M.segHit(x, 1.8, z, d.x, 1.8, d.z) >= 1 && M.segHit(x, 1.6, z, x + ux * 11.5, 5.4, z + uz * 11.5) >= 1) return { i: d.i, x: r2(x), z: r2(z), h: Math.atan2(-ux, -uz) };
  }
  return null;
}).filter(Boolean);

const BASE = (process.argv[2] || 'http://localhost:3400').replace(/\/$/, '');
const OUT = process.argv[3] || path.join(process.cwd(), 'test-shots');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SLOW = { timeout: 120000 };
const BLUE = 2, BLUE_HEX = 0x4d8dff;           // the third swatch
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

// team (issue #24): 0 A, 1 B, or nothing for the form's default (automatic)
async function player(browser, name, viewport, color, team) {
  const ctx = await browser.createBrowserContext();   // its own storage, like another person's browser
  const page = await ctx.newPage();
  await page.setViewport(viewport || { width: 960, height: 600 });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(BASE + '/?test', { waitUntil: 'domcontentloaded', ...SLOW });
  await page.waitForFunction(() => !document.getElementById('startBtn').disabled, SLOW);
  if (name) {
    await page.type('#nameIn', name);
    if (color !== undefined) await page.click(`#swatches input[value="${color}"]`);
    if (team !== undefined) await page.click(`input[name=team][value="${team}"]`);
    await page.click('#startBtn');
    await page.waitForFunction(() => window.WOD && WOD.state === 'drive', SLOW);
  }
  return page;
}

// put the tank at (x,z) facing h, standing still
const place = (page, x, z, h) => page.evaluate((x, z, h) => Object.assign(WOD.car, { x, z, h, v: 0 }), x, z, h);
// clear what earlier hits did (the bots', the spawn shield), so the next parcel counts; hits: how many recent hits to pretend
// (since issue #14 a hit in hitLog is [time, weight]: n recent parcel hits are n entries [now, 1])
const fresh = (page, hits = 0) => page.evaluate(n => Object.assign(WOD.car, { immT: 0, topT: 0, roll: 0, slowT: 0, hitLog: Array.from({ length: n }, () => [performance.now(), 1]) }), hits);
const row = (page, name) => page.$$eval('#board li', (lis, name) => lis.map(li => [li.querySelector('.nm').textContent, li.querySelector('b').textContent]).find(r => r[0] === name), name);
// wait until this page draws the other player's tank near (x,z)
const seesAt = (page, x, z) => page.waitForFunction((x, z) => [...WOD.NET.others.values()].some(o => !o.bot && o.on && Math.hypot(o.x - x, o.z - z) < 1), SLOW, x, z);
// put two players at their places until each page draws the other there (issue #24: a passing bot's tank may shove one aside)
async function meet(p, px, pz, ph, q, qx, qz, qh) {
  const near = (pg, x, z) => pg.evaluate((x, z) => [...WOD.NET.others.values()].some(o => !o.bot && o.on && Math.hypot(o.x - x, o.z - z) < 1.5), x, z);
  for (let i = 0; i < 40; i++) {
    await place(p, px, pz, ph); await place(q, qx, qz, qh);
    await Promise.all([frames(p, 3), frames(q, 3)]);
    if (await near(p, qx, qz) && await near(q, px, pz)) return true;
  }
  return false;
}
// a few rendered frames, so the camera and the HUD catch up
const frames = (page, n) => page.evaluate(n => new Promise(r => { const f = () => (--n > 0 ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }), n);

// Rosta fires one parcel at Petr, who stands 26 units in front of him (DUEL). A hit counts when Petr's own tank registers it and Rosta
// gains the 10 points for it (a bot driving between them can take the parcel instead: 1 point, not a hit on Petr).
async function shoot(a, b, petrHits) {
  await place(a, DUEL.ax, DUEL.az, DUEL.h);
  await place(b, DUEL.bx, DUEL.bz, DUEL.h + Math.PI);
  await fresh(b, petrHits);
  const before = await a.evaluate(() => WOD.NET.pts), sid = await a.evaluate(() => WOD.NET.sid);
  await a.evaluate(() => { WOD.K.fire = true; });
  await a.waitForFunction(s => WOD.NET.sid > s, SLOW, sid);
  await a.evaluate(() => { WOD.K.fire = false; });
  const hit = await b.waitForFunction(n => WOD.car.hitLog.length > n || WOD.car.topT > 0, { timeout: 25000 }, petrHits).then(() => true, () => false)
    && await a.waitForFunction(p => WOD.NET.pts >= p + 10, { timeout: 25000 }, before).then(() => true, () => false);
  return { hit, gain: (await a.evaluate(() => WOD.NET.pts)) - before };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 240000,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
  });
  try {
    const intro = await player(browser, null);
    await frames(intro, 3);
    await intro.screenshot({ path: path.join(OUT, '1-intro.png') });
    check((await intro.$$('#swatches input')).length === 12, 'the join form offers 12 tank colours');
    check((await intro.$$eval('input[name=team]', l => l.map(i => i.value + (i.checked ? '*' : '')).join())) === 'auto*,0,1', 'issue #24: the join form offers a team, automatic by default, A or B');
    await intro.close();

    const a = await player(browser, 'Rosta', null, BLUE, 0);
    // issue #16: he starts at one of the map's spawn points, on a street of Karlín (or, with all of them taken, in the depot's yard);
    // issue #24: in his team's half (A: the west)
    const s0 = await a.evaluate(() => ({ x: WOD.car.x, z: WOD.car.z }));
    check(M.SPAWNS.some(p => Math.hypot(p.x - s0.x, p.z - s0.z) < 0.5) && M.onRoad(s0.x, s0.z) && RU.homeSide(0, s0.x) || Math.hypot(M.DEPOT.park.x - s0.x, M.DEPOT.park.z - s0.z) < 0.5,
      `Rosta starts on a street, at one of the map's spawn points, in A's half (${s0.x.toFixed(1)}, ${s0.z.toFixed(1)})`);
    const b = await player(browser, 'Petr', null, undefined, 1);
    check((await a.evaluate(() => WOD.NET.color)) === BLUE_HEX, 'Rosta drives the blue tank he picked');
    await a.waitForFunction(() => [...WOD.NET.others.values()].some(o => o.name === 'Petr' && o.on), SLOW);
    check(true, 'Rosta sees Petr\'s tank in the city');
    // issue #24: the bots fill both teams (TEAM_SIZE a team, the people counted)
    const botsSeen = await a.evaluate(() => [...WOD.NET.others.values()].filter(o => o.bot).map(o => o.name + ':' + 'AB'[o.team]).sort().join());
    check(/:A/.test(botsSeen) && /:B/.test(botsSeen) && botsSeen.split(',').every(s => /^BOT\d+:[AB]$/.test(s)), `Rosta sees the bots, in both teams (${botsSeen})`);
    check((await a.$eval('#online', e => e.textContent)) === '2 online', 'the HUD says 2 online (the bots do not count)');
    // issue #24: Rosta plays for A and Petr for B, as they picked; each sees the other's name glow in the other team's colour, and the
    // scoreboard lists his own team first
    const hex = c => '#' + c.toString(16).padStart(6, '0');
    const teams = await Promise.all([a, b].map(p => p.evaluate(() => WOD.NET.team)));
    check(teams[0] === 0 && teams[1] === 1, `Rosta is in team A and Petr in team B (${teams})`);
    const tagOf = (p, name) => p.evaluate(n => { const o = [...WOD.NET.others.values()].find(q => q.name === n); return o && o.team + ' ' + o.tag.style.getPropertyValue('--c'); }, name);
    const [ta, tb] = [await tagOf(a, 'Petr'), await tagOf(b, 'Rosta')];
    check(ta === '1 ' + hex(RU.TEAM_COL[1]) && tb === '0 ' + hex(RU.TEAM_COL[0]), `each sees the other in the other team's colour (Rosta sees Petr: ${ta}; Petr sees Rosta: ${tb})`);
    const firstTeam = p => p.$eval('#board li.team', e => e.className);
    check((await firstTeam(a)) === 'team t0' && (await firstTeam(b)) === 'team t1', 'each one\'s scoreboard lists his own team first');
    check(!(await a.$eval('#teamBar', e => e.hidden)), 'the team bar shows the round');

    // the shared city: at the same moment of the server's clock both have every car and pedestrian in the same place. (Comparing
    // what the two windows show right now would measure headless Chrome, which draws a frame every few hundred ms, not the game.)
    await Promise.all([a, b].map(p => p.waitForFunction(() => WOD.WORLD.buf.length > 2, SLOW)));
    const range = p => p.evaluate(() => [WOD.WORLD.buf[0].t, WOD.WORLD.buf[WOD.WORLD.buf.length - 1].t]);
    const gap = (x, y) => Math.max(...x.map((c, i) => Math.hypot(c[0] - y[i][0], c[1] - y[i][1])));
    let sa = null, sb = null, s = 0;
    for (let i = 0; i < 5 && !(sa && sb); i++) {
      // one pedestrian snapshot back from the older of the two newest rows, but not before either buffer starts: under load one
      // page can be half a second behind the other and hold only a few rows (issue #16: a run once found no time both held)
      const [ra, rb] = await Promise.all([range(a), range(b)]);
      s = Math.max(Math.min(ra[1], rb[1]) - 100, Math.max(ra[0], rb[0]) + 1);
      [sa, sb] = await Promise.all([a.evaluate(t => WOD.worldAt(t), s), b.evaluate(t => WOD.worldAt(t), s)]);
      if (!(sa && sb)) await frames(a, 3);
    }
    check(sa && sb && gap(sa.cars, sb.cars) < 0.01 && gap(sa.peds, sb.peds) < 0.01, `Rosta and Petr see the same city at server time ${s} (largest gap: ${sa && sb ? gap(sa.cars, sb.cars).toFixed(3) + ' car, ' + gap(sa.peds, sb.peds).toFixed(3) + ' pedestrian' : 'no data'})`);

    // a tank against a house's wall (issue #16: a real facade of Karlín, a footprint polygon; it was the site's fence): full speed
    // head-on does not get into it, and a tank along it that steers into it still drives on (the old blocked-or-free test stopped it
    // dead). The wall: the first street wall with no tree or lamp in the tank's way.
    const wall = await a.evaluate(ws => ws.find(w => {
      const at = (t, k) => [w.ax + w.ux * t + w.nx * k, w.az + w.uz * t + w.nz * k];
      for (let k = 2.6; k <= 8; k += 0.5) if (!WOD.free(...at(w.L / 2, k), 1.0)) return false;
      for (let t = w.L * 0.15; t <= w.L * 0.85; t += 1) if (!WOD.free(...at(t, 1.1), 1.0)) return false;
      return true;
    }) || null, WALLS);
    check(!!wall, `a street wall to drive against (${WALLS.length} found in the map)`);
    if (wall) {
      const at = (t, k) => [wall.ax + wall.ux * t + wall.nx * k, wall.az + wall.uz * t + wall.nz * k];
      const gapOf = c => (c.x - wall.ax) * wall.nx + (c.z - wall.az) * wall.nz;           // the tank's centre from the wall's face
      const [hx, hz] = at(wall.L / 2, 8);
      await place(a, hx, hz, Math.atan2(-wall.nx, -wall.nz));
      await a.evaluate(() => { WOD.car.v = 24; WOD.K.up = true; });
      await frames(a, 12);
      const hit = await a.evaluate(() => { WOD.K.up = false; return { x: WOD.car.x, z: WOD.car.z }; });
      check(gapOf(hit) > 1.5, `head-on at full speed, the tank stops at the wall (its front ${(gapOf(hit) - 1.55).toFixed(2)} from the face)`);
      const [sx, sz] = at(wall.L * 0.15, 1.1);
      await place(a, sx, sz, Math.atan2(wall.ux, wall.uz));                                // along it, the wall on the right
      await a.evaluate(() => { WOD.car.v = 6; WOD.K.up = true; WOD.K.right = true; });
      await frames(a, 25);
      const slid = await a.evaluate(() => { WOD.K.up = WOD.K.right = false; WOD.car.v = 0; return { x: WOD.car.x, z: WOD.car.z }; });
      const along = (slid.x - sx) * wall.ux + (slid.z - sz) * wall.uz;
      check(along > 2 && gapOf(slid) > 0.9, `steering into the wall, the tank still drives along it (${along.toFixed(1)} units, ${gapOf(slid).toFixed(2)} from it)`);
    }

    // a car Rosta's tank shoves becomes his: it moves on Petr's screen as on his, and is the traffic's again once it rests
    const rostaId = await a.evaluate(() => WOD.NET.id);
    await a.evaluate(() => { const c = WOD.TRAFFIC[0]; Object.assign(WOD.car, { x: c.x - c.hx * 3, z: c.z - c.hz * 3, h: Math.atan2(c.hx, c.hz), v: 12 }); WOD.K.up = true; });
    await a.waitForFunction(() => WOD.TRAFFIC[0].mine, SLOW);
    await a.evaluate(() => { WOD.K.up = false; WOD.car.v = 0; });
    check(true, 'Rosta\'s tank shoves car 0 and it is his');
    const seen = await b.waitForFunction(id => WOD.TRAFFIC[0].net === id, SLOW, rostaId).then(() => true, () => false);
    check(seen, 'Petr sees that Rosta is pushing it');
    await place(a, DUEL.ax, DUEL.az, DUEL.h);
    const back = await b.waitForFunction(() => WOD.TRAFFIC[0].net === 0, SLOW).then(() => true, () => false);
    check(back && !(await a.evaluate(() => WOD.TRAFFIC[0].mine)), 'once it rests Rosta lets go, and it is the traffic\'s again');

    // Rosta and Petr on a street near the middle of the city (issue #16: DUEL, found in the map), 26 units apart, facing each other
    console.log(`     the duel: ${DUEL.name}, (${DUEL.ax}, ${DUEL.az}) and (${DUEL.bx}, ${DUEL.bz})`);
    await meet(a, DUEL.ax, DUEL.az, DUEL.h, b, DUEL.bx, DUEL.bz, DUEL.h + Math.PI);
    await Promise.all([frames(a, 12), frames(b, 12)]);
    await a.screenshot({ path: path.join(OUT, '2-rosta-sees-petr.png') });
    await b.screenshot({ path: path.join(OUT, '3-petr-sees-rosta.png') });

    // names only in plain sight: on the open street Petr is spotted; at two spawn points with houses between them (issue #16: HIDE,
    // found in the map) he is not
    const petr = () => [...WOD.NET.others.values()].find(o => o.name === 'Petr');
    await a.waitForFunction(`(${petr})().tag.visible`, SLOW);
    check(true, 'Petr\'s name shows while he is in plain sight');
    check(!!HIDE, 'two spawn points with houses between them');
    for (let i = 0; i < 40; i++) {                                              // (a bot's tank may shove Petr aside, issue #24)
      await place(b, HIDE.bx, HIDE.bz, HIDE.bh); await frames(a, 3);
      if (await a.evaluate((x, z) => [...WOD.NET.others.values()].some(o => !o.bot && o.on && Math.hypot(o.x - x, o.z - z) < 1.5), HIDE.bx, HIDE.bz)) break;
    }
    await place(a, HIDE.ax, HIDE.az, HIDE.ah);
    await a.waitForFunction(`!(${petr})().tag.visible && !(${petr})().seen`, SLOW);
    check(true, 'behind a block of houses his name is gone');

    // one hit: 10 points
    let shot = { hit: false };
    for (let i = 0; i < 8 && !shot.hit; i++) {
      shot = await shoot(a, b, 0);
      console.log(`     parcel ${i + 1}: ${shot.hit ? 'hit Petr' : 'missed Petr'}`);
    }
    check(shot.hit && shot.gain >= 10, `a hit on Petr gives Rosta 10 points (+${shot.gain})`);
    const pts = await a.evaluate(() => WOD.NET.pts);
    await b.waitForFunction(p => [...document.querySelectorAll('#board li')].some(li => li.querySelector('.nm').textContent === 'Rosta' && Number(li.querySelector('b').textContent) >= p), SLOW, pts);
    const ra = await row(a, 'Rosta'), rb = await row(b, 'Rosta');
    check(ra && rb && Number(ra[1]) >= pts && Number(rb[1]) >= pts, `both scoreboards show Rosta's points (${ra && ra[1]} | ${rb && rb[1]})`);
    check((await a.$eval('#myPts', e => e.textContent)) === String(await a.evaluate(() => WOD.NET.pts)), 'Rosta\'s own points counter matches');

    // the hit that destroys Petr (he had two recent hits): an explosion, and Petr comes back elsewhere
    let killed = false;
    for (let i = 0; i < 8 && !killed; i++) {
      const s = await shoot(a, b, 2);
      killed = s.hit && (await b.evaluate(d => WOD.car.topT > 0 || Math.hypot(WOD.car.x - d.bx, WOD.car.z - d.bz) > 20, DUEL));
      console.log(`     parcel ${i + 1}: ${killed ? 'destroyed Petr' : 'no kill yet'}`);
    }
    check(killed, 'the third hit destroys Petr\'s tank');
    await Promise.all([frames(a, 3), frames(b, 3)]);
    await a.screenshot({ path: path.join(OUT, '4-rosta-destroys-petr.png') });
    await b.waitForFunction(d => WOD.car.topT === 0 && Math.hypot(WOD.car.x - d.bx, WOD.car.z - d.bz) > 20, SLOW, DUEL);
    check(RU.homeSide(1, await b.evaluate(() => WOD.car.x)), 'Petr comes back at another place, in B\'s half (issue #24)');
    check(await b.evaluate(() => WOD.car.immT > 0), 'and is immune for a moment after it');
    await frames(b, 4);
    await b.screenshot({ path: path.join(OUT, '5-petr-respawned.png') });

    // issue #24, friendly fire: Tereza joins Rosta's team and stands where Rosta stood in the duel, Rosta where Petr stood. Her parcels
    // bounce off his tank and do nothing there: his browser applies no hit and reports none of hers (the server would not score one
    // either), and she scores nothing. (A bot's parcel may still hit Rosta meanwhile: the test watches for hits by Tereza.)
    const t = await player(browser, 'Tereza', null, undefined, 0);
    const terezaId = await t.evaluate(() => WOD.NET.id);
    check((await t.evaluate(() => WOD.NET.team)) === 0, 'Tereza joins team A');
    await a.evaluate(() => {                                                       // Rosta's page notes every hit it reports
      const ws = WOD.NET.ws, send = ws.send.bind(ws); window.HITS = [];
      ws.send = d => { try { const m = JSON.parse(d); if (m.t === 'hit') HITS.push(m.by); } catch (_) { /* not JSON */ } return send(d); };
    });
    await meet(t, DUEL.ax, DUEL.az, DUEL.h, a, DUEL.bx, DUEL.bz, DUEL.h + Math.PI);
    for (let i = 0; i < 3; i++) {
      await place(t, DUEL.ax, DUEL.az, DUEL.h); await place(a, DUEL.bx, DUEL.bz, DUEL.h + Math.PI); await fresh(a, 0);
      const sid = await t.evaluate(() => WOD.NET.sid);
      await t.evaluate(() => { WOD.K.fire = true; });
      await t.waitForFunction(s => WOD.NET.sid > s, SLOW, sid);
      await t.evaluate(() => { WOD.K.fire = false; });
      await frames(a, 25);
    }
    const byTereza = await a.evaluate(id => HITS.filter(b => b === id).length, terezaId);
    // (her own points are not checked: a bot of B crossing the line may take a parcel; the server's side of this is in the smoke test)
    check(byTereza === 0 && await a.evaluate(id => WOD.teams.friendly(id), terezaId),
      `Tereza's parcels do her teammate Rosta no harm and score nothing (${byTereza} hit(s) reported)`);
    await t.close();

    // issue #24, a zone: Rosta's tank stands in Viadukt (in A's half); the capture runs towards A, and both his HUD and Petr's show it
    // (the zone's chip in the team bar); his own HUD shows the capture meter
    const Z = RU.ZONES[0], ze = M.nearestEdge(Z.x, Z.z), zat = M.edgePos(ze.e, ze.s, 0);
    await place(a, Z.x, Z.z, Math.atan2(zat.hx, zat.hz));
    await a.waitForFunction(() => !document.getElementById('cap').hidden, SLOW);
    check(true, 'in the zone, Rosta\'s HUD shows the capture meter');
    const capA = await a.waitForFunction(() => WOD.teams.TM.z[0][0] === 0 || WOD.teams.TM.z[0][1] > 30, { timeout: 240000 }).then(() => true, () => false);
    const capB = await b.waitForFunction(() => WOD.teams.TM.z[0][0] === 0 || WOD.teams.TM.z[0][1] > 30, { timeout: 60000 }).then(() => true, () => false);
    // the zone's chip: held by A (class o0), or its capture bar over 30 % in A's colour
    const chip = p => p.$eval('#zones .zc', e => { const i = e.querySelector('i'); return { o0: e.classList.contains('o0'), w: parseFloat(i.style.width) || 0, c: i.style.getPropertyValue('--pc') }; });
    const chipA = c => c.o0 || (c.w > 30 && c.c === hex(RU.TEAM_COL[0]));
    const [ca, cb] = [await chip(a), await chip(b)];
    check(capA && capB && chipA(ca) && chipA(cb) && (await b.$eval('#cap', e => e.hidden)),
      `Rosta captures Viadukt for A, in his HUD (${JSON.stringify(ca)}) and in Petr's (${JSON.stringify(cb)})`);
    await frames(a, 4);
    await a.screenshot({ path: path.join(OUT, '5a-rosta-captures.png') });

    // issue #24, a depot: Rosta's parcels hit one of B's supply depots that stands; his browser reports it (thit), the server takes the
    // damage, and both see it
    const dep = await a.evaluate(l => l.find(p => WOD.teams.TM.d[p.i][0] > 0) || null, AT_DEPOT);
    check(!!dep, `one of B's depots stands, with a clear shot at it (${AT_DEPOT.length} places found in the map)`);
    if (dep) {
      const hp0 = await a.evaluate(i => WOD.teams.TM.d[i][0], dep.i);
      let dmg = false;
      for (let i = 0; i < 6 && !dmg; i++) {
        await place(a, dep.x, dep.z, dep.h); await fresh(a, 0);
        const sid = await a.evaluate(() => WOD.NET.sid);
        await a.evaluate(() => { WOD.K.fire = true; });
        await a.waitForFunction(s => WOD.NET.sid > s, SLOW, sid);
        await a.evaluate(() => { WOD.K.fire = false; });
        dmg = await a.waitForFunction((i, h) => WOD.teams.TM.d[i][0] < h, { timeout: 30000 }, dep.i, hp0).then(() => true, () => false);
        console.log(`     parcel ${i + 1} at depot ${dep.i}: ${dmg ? 'hit' : 'no damage yet'}`);
      }
      const seen = dmg && await b.waitForFunction((i, h) => WOD.teams.TM.d[i][0] < h, { timeout: 30000 }, dep.i, hp0).then(() => true, () => false);
      check(dmg && seen, `Rosta's parcels damage B's depot ${dep.i}, in his view and in Petr's`);
      await frames(a, 6);
      await a.screenshot({ path: path.join(OUT, '5b-rosta-hits-depot.png') });
    }

    // issue #14: Petr switches to a plane (V); it comes in at the edge of the airspace and flies; Rosta sees a plane; Petr is put
    // 30 units up and 25 ahead of Rosta, down the street (issue #16: Karlín's houses beside it would hide him), and Rosta's
    // anti-aircraft gun (E) aims itself at him and hits (5 points a bullet in a plane)
    await b.keyboard.press('KeyV');
    await b.waitForFunction(() => WOD.car.k === 1 && WOD.car.topT === 0, SLOW);
    const fly0 = await b.evaluate(() => ({ x: WOD.car.x, y: WOD.car.y, z: WOD.car.z }));
    await frames(b, 10);
    await frames(b, 1);                                                                    // (the HUD shows the frame's height)
    const fly1 = await b.evaluate(() => ({ x: WOD.car.x, y: WOD.car.y, z: WOD.car.z, alt: document.getElementById('alt').textContent }));
    // (the height in metres: issue #16, 1 unit is 1.5 m, M.UNIT_M)
    check(fly0.y > 40 && Math.hypot(fly1.x - fly0.x, fly1.z - fly0.z) > 5 && Math.abs(Number(fly1.alt) - fly1.y * M.UNIT_M) < 3, `V puts Petr in a plane that flies (${Math.round(fly0.x)},${Math.round(fly0.z)} → ${Math.round(fly1.x)},${Math.round(fly1.z)}, ${fly1.alt} m)`);
    await a.waitForFunction(() => [...WOD.NET.others.values()].some(o => o.name === 'Petr' && o.on && o.k === 1 && o.y > 20 && o.pg && o.pg.isEnabled()), SLOW);
    check(true, 'Rosta sees Petr\'s plane in the air');
    await b.screenshot({ path: path.join(OUT, '5b-petr-flies.png') });
    const ptsAA = await a.evaluate(() => WOD.NET.pts);
    await a.evaluate(() => { WOD.car.immT = 0; WOD.HELD.add('KeyE'); });
    let flak = false;
    for (let i = 0; i < 12 && !flak; i++) {
      const r = await a.evaluate(() => ({ x: WOD.car.x, z: WOD.car.z, h: WOD.car.h }));
      await b.evaluate(r => { Object.assign(WOD.car, { x: r.x + Math.sin(r.h) * 25, z: r.z + Math.cos(r.h) * 25, y: 30, h: r.h, p: 0, v: 18, immT: 0 }); Object.assign(WOD.pl, { aimY: r.h, aimP: 0, thr: 0.3 }); }, r);
      await frames(a, 8);
      flak = (await a.evaluate(() => WOD.NET.pts)) > ptsAA;
    }
    await a.evaluate(() => WOD.HELD.delete('KeyE'));
    check(flak, 'Rosta\'s anti-aircraft gun hits Petr\'s plane and scores');
    await a.screenshot({ path: path.join(OUT, '5c-rosta-flak.png') });

    // issue #20: Petr takes a ship (3): it comes out at one of the river's spawn points, the telegraph (W three times: full ahead)
    // sets it going and it stays on the water; Rosta sees the ship, its turrets turned as Petr turns them. Rosta takes a ship too, is
    // put 90 down the river from Petr facing him, aims at him and fires salvoes (the reload skipped) until a shell hits: 4 points.
    // Then Petr's ship has a pretend hit 15 s old worth 2.8 (a tank's 8 s window would have dropped it, a ship's 20 s keep it): the
    // next shell sinks it, and it comes back at another spawn point.
    await b.keyboard.press('Digit3');
    await b.waitForFunction(() => WOD.car.k === 2 && WOD.car.topT === 0, SLOW);
    const sea0 = await b.evaluate(() => ({ x: WOD.car.x, z: WOD.car.z }));
    check(NV.SHIP_SPAWNS.some(p => Math.hypot(p.x - sea0.x, p.z - sea0.z) < 0.5) && NV.inWater(sea0.x, sea0.z, 2), `3 puts Petr in a ship at one of the river's spawn points (${sea0.x}, ${sea0.z})`);
    for (let i = 0; i < 3; i++) { await b.keyboard.down('KeyW'); await frames(b, 2); await b.keyboard.up('KeyW'); await frames(b, 1); }
    await b.waitForFunction(() => WOD.car.v > 4, SLOW);
    const sea1 = await b.evaluate(() => ({ x: WOD.car.x, z: WOD.car.z, tel: WOD.sh.tel, wet: WOD.naval.inWater(WOD.car.x, WOD.car.z, 0) }));
    check(sea1.tel === 4 && sea1.wet && Math.hypot(sea1.x - sea0.x, sea1.z - sea0.z) > 2, `full ahead, Petr's ship sails on the river (${Math.hypot(sea1.x - sea0.x, sea1.z - sea0.z).toFixed(1)} units)`);
    await b.evaluate(() => { WOD.sh.tel = 1; WOD.car.v = 0; WOD.sh.aimY = WOD.car.h + 1.2; });
    const petrShip = () => [...WOD.NET.others.values()].find(o => o.name === 'Petr' && o.on && o.k === 2 && o.sg && o.sg.isEnabled());
    await a.waitForFunction(`!!(${petrShip})()`, SLOW);
    check(true, 'Rosta sees Petr\'s ship on the river');
    await b.waitForFunction(() => WOD.sh.tur[0].st !== 'turn', SLOW);
    const yaw = await b.evaluate(() => WOD.sh.tur[0].c);
    const yawSeen = await a.waitForFunction((y, f) => { const o = eval(f)(); return o && Math.abs(Math.atan2(Math.sin(o.a - y), Math.cos(o.a - y))) < 0.15; }, SLOW, yaw, `(${petrShip})`).then(() => true, () => false);
    check(yawSeen, `Rosta sees Petr's fore turret turned as Petr turned it (${yaw.toFixed(2)} rad)`);
    await a.keyboard.press('Digit3');
    await a.waitForFunction(() => WOD.car.k === 2 && WOD.car.topT === 0, SLOW);
    const pp = await b.evaluate(() => ({ x: WOD.car.x, z: WOD.car.z }));
    let spot = null;
    for (const d of [90, -90, 75, -75, 60, -60]) {
      const h = NV.riverDir(pp.x, pp.z), x = pp.x + Math.sin(h) * d, z = pp.z + Math.cos(h) * d;
      if (NV.inWater(x, z, 10)) { spot = { x, z, h: Math.atan2(pp.x - x, pp.z - z) }; break; }
    }
    check(!!spot, 'a place on the river 60 to 90 from Petr\'s ship for Rosta\'s');
    await a.evaluate(s => { Object.assign(WOD.car, { x: s.x, z: s.z, h: s.h, v: 0, immT: 0 }); WOD.sh.tel = 1; }, spot);
    await seesAt(b, spot.x, spot.z);
    await seesAt(a, pp.x, pp.z);
    const aimAtPetr = () => a.evaluate(f => { const o = eval(f)(), c = WOD.car, d = Math.hypot(o.x - c.x, o.z - c.z); WOD.sh.aimY = Math.atan2(o.x - c.x, o.z - c.z); WOD.sh.aimP = -Math.atan2(5.4, d); }, `(${petrShip})`);
    // one salvo at Petr's ship (both turrets loaded); true when Petr's ship registers a hit and Rosta scores at least `gain`
    const salvo = async (pretend, gain) => {
      await b.evaluate(p => Object.assign(WOD.car, { immT: 0, topT: 0, hitLog: p ? [[performance.now() - 15000, p]] : [] }), pretend);
      await aimAtPetr();
      await a.waitForFunction(() => WOD.sh.tur.every(t => t.st === 'ok' || t.st === 'block') && WOD.sh.tur.some(t => t.st === 'ok'), { timeout: 240000 });   // (the first time the turrets swing round: 4 s of game time)
      const before = await a.evaluate(() => WOD.NET.pts), n = pretend ? 1 : 0;
      await a.evaluate(() => { WOD.input.lmb = true; });
      await a.waitForFunction(() => WOD.sh.tur.some(t => t.st === 'load'), SLOW);
      await a.evaluate(() => { WOD.input.lmb = false; });
      const hit = await b.waitForFunction(n => WOD.car.hitLog.length > n || WOD.car.topT > 0, { timeout: 30000 }, n).then(() => true, () => false)
        && await a.waitForFunction((p, g) => WOD.NET.pts >= p + g, { timeout: 30000 }, before, gain).then(() => true, () => false);
      await a.evaluate(() => WOD.sh.tur.forEach(t => { t.cd = 0; }));
      return { hit, gain: (await a.evaluate(() => WOD.NET.pts)) - before };
    };
    let sh1 = { hit: false, gain: 0 };
    for (let i = 0; i < 6 && !sh1.hit; i++) { sh1 = await salvo(0, 4); console.log(`     salvo ${i + 1}: ${sh1.hit ? 'hit Petr\'s ship' : 'missed'}`); }
    check(sh1.hit && sh1.gain >= 4, `a shell in Petr's ship gives Rosta 4 points (+${sh1.gain})`);
    await Promise.all([frames(a, 3), frames(b, 3)]);
    await a.screenshot({ path: path.join(OUT, '5d-rosta-shells-petr.png') });
    let sunk = false;
    for (let i = 0; i < 6 && !sunk; i++) {
      const r = await salvo(2.8, 4);
      sunk = r.hit && await b.evaluate(() => WOD.car.topT > 0 || WOD.car.y < -1);
      console.log(`     salvo ${i + 1}: ${sunk ? 'sank Petr\'s ship' : 'no kill yet'}`);
    }
    check(sunk, 'with a hit 15 s old still counted (a ship\'s window is 20 s), the next shell sinks Petr\'s ship');
    await Promise.all([frames(a, 6), frames(b, 6)]);
    await a.screenshot({ path: path.join(OUT, '5e-petr-sinks.png') });
    await b.waitForFunction(p => WOD.car.k === 2 && WOD.car.topT === 0 && Math.hypot(WOD.car.x - p.x, WOD.car.z - p.z) > 20, SLOW, pp);
    check(await b.evaluate(() => WOD.car.immT > 0 && WOD.naval.inWater(WOD.car.x, WOD.car.z, 0)), 'Petr\'s ship comes back elsewhere on the river, immune for a moment');

    // issue #26: Velemlok, the giant salamander in the Vltava. Rosta's ship card counts down to its next appearance (obj.g.next, the
    // server's moment, so the same for everyone). The rest needs a server that calls it soon (MON_FIRST_S=60 MON_EVERY_S=5
    // MON_LIFE_S=90; without it the test says it skipped the rest): it surfaces and both pages draw it, Rosta's card says it is here
    // and his team bar shows its hit points; his shells hit it, his page reports them (mhit) and the damage counts for team A in both
    // pages. (Headless, a shell flies several times longer than the server's monster swims meanwhile: a moving Velemlok is often missed,
    // so the test fires until one hits, also into its next appearance.)
    {
      const chip = await a.evaluate(() => ({ hidden: document.getElementById('seaMon').hidden, t: document.getElementById('seaMonT').textContent, st: WOD.mon.st, left: (WOD.mon.next - WOD.serverNow()) / 1000 }));
      const mm = /(\d+):(\d\d)$/.exec(chip.t), shown = mm ? Number(mm[1]) * 60 + Number(mm[2]) : NaN;
      check(!chip.hidden && (chip.st === 0 ? Math.abs(shown - chip.left) < 2.5 || (chip.left < 1.5 && chip.t === 'Velemlok se blíží…') : chip.st === 3 || chip.t === 'Velemlok je ve Vltavě!'),
        `issue #26: Rosta's ship card counts down to Velemlok ("${chip.t}"; obj.g says ${chip.left.toFixed(1)} s)`);
      if (chip.st === 0 && chip.left > MON_SOON) console.log(`     skip Velemlok's fight: it comes in ${Math.round(chip.left)} s (start the server with MON_FIRST_S=60 MON_EVERY_S=5 MON_LIFE_S=90)`);
      else {
        const outNow = () => WOD.mon.on && WOD.mon.dst === 2 && WOD.mon.next - WOD.serverNow() > 8000;
        const out = await a.waitForFunction(outNow, { timeout: ((chip.st === 0 ? chip.left : 30) + 150) * 1000, polling: 500 }).then(() => true, () => false);
        const seenB = out && await b.waitForFunction(() => WOD.mon.on && WOD.monModel().root.isEnabled(), { timeout: 30000 }).then(() => true, () => false);
        const hud = await a.evaluate(() => ({ drawn: WOD.mon.on && WOD.monModel().root.isEnabled(), chip: document.getElementById('seaMonT').textContent, bar: !document.getElementById('tbMon').hidden, hp: document.getElementById('tbMonHp').style.width }));
        check(out && seenB && hud.drawn && hud.chip === 'Velemlok je ve Vltavě!' && hud.bar,
          `Velemlok surfaces: both pages draw it, Rosta's card says "${hud.chip}", his team bar shows its hit points (${hud.hp})`);
        // Rosta's page notes the hits it reports on Velemlok; his ship 50 to 90 off its side, broadside on, the guns trained on it
        await a.evaluate(() => {
          const ws = WOD.NET.ws, send = ws.send.bind(ws); window.MHIT = [];
          ws.send = d => { try { const m = JSON.parse(d); if (m.t === 'mhit') MHIT.push(m); } catch (_) { /* not JSON */ } return send(d); };
        });
        const nearMon = () => a.evaluate(() => {
          const m = WOD.mon.pose, hx = Math.sin(m.h), hz = Math.cos(m.h);
          for (const d of [75, 60, 90, 50]) for (const s of [1, -1]) for (const al of [0, 15, -15, 30, -30]) {
            const x = m.x + hz * s * d + hx * al, z = m.z - hx * s * d + hz * al;
            if (!WOD.naval.inWater(x, z, 8)) continue;
            const h = Math.atan2(m.x - x, m.z - z);
            Object.assign(WOD.car, { x, z, h: h + 1.2, v: 0, immT: 0, hitLog: [] }); WOD.sh.tel = 1;
            WOD.sh.aimY = h; WOD.sh.aimP = -Math.atan2(3, Math.hypot(m.x - x, m.z - z)); return true;
          }
          return false;
        });
        let hit = false, counted = false, d0 = 0, d1 = 0;
        for (let i = 0; i < 14 && !counted; i++) {
          await a.waitForFunction(() => WOD.car.topT === 0, SLOW);                    // (its tail or its jet may sink Rosta's ship)
          await a.waitForFunction(outNow, { timeout: 180000, polling: 500 }).catch(() => {});
          await nearMon(); await frames(a, 2); await nearMon();
          await a.waitForFunction(() => WOD.sh.tur.some(t => t.st === 'ok'), { timeout: 90000 }).catch(() => {});
          await nearMon();
          const n0 = await a.evaluate(() => MHIT.length);
          d0 = await a.evaluate(() => WOD.mon.dmg[0]);
          await a.evaluate(() => { WOD.input.lmb = true; });
          await a.waitForFunction(() => WOD.sh.tur.some(t => t.st === 'load'), { timeout: 30000 }).catch(() => {});
          await a.evaluate(() => { WOD.input.lmb = false; });
          hit = await a.waitForFunction(n => MHIT.length > n, { timeout: 20000 }, n0).then(() => true, () => false);
          counted = hit && await a.waitForFunction((d, s) => WOD.mon.dmg[0] >= d + s, { timeout: 10000 }, d0, MS.MON_DMG.shell).then(() => true, () => false);
          await a.evaluate(() => WOD.sh.tur.forEach(t => { t.cd = 0; }));
          console.log(`     salvo ${i + 1} at Velemlok: ${counted ? 'hit, counted' : hit ? 'hit, not counted (yet)' : 'missed'}`);
        }
        const mh = await a.evaluate(() => MHIT[MHIT.length - 1] || null);
        const seenDmg = counted && await b.waitForFunction((d, s) => WOD.mon.dmg[0] >= d + s, { timeout: 10000 }, d0, MS.MON_DMG.shell).then(() => true, () => false);
        d1 = await a.evaluate(() => WOD.mon.dmg[0]);
        check(counted && seenDmg && mh && mh.k === 2, `Rosta's shell hits Velemlok (mhit k ${mh && mh.k}) and the damage counts for team A, in his page and Petr's (A ${d0} -> ${d1})`);
        await frames(a, 3);
        await a.screenshot({ path: path.join(OUT, '5f-rosta-shells-velemlok.png') });
      }
    }

    // names: a taken one and a bot's one are refused under the form
    const c = await player(browser, null);
    await c.type('#nameIn', 'petr');
    await c.click('#startBtn');
    await c.waitForFunction(() => !document.getElementById('joinErr').hidden, SLOW);
    check((await c.$eval('#joinErr', e => e.textContent)).includes('jméno'), 'a taken name gets an error under the form');
    await c.$eval('#nameIn', e => { e.value = ''; });
    await c.type('#nameIn', 'BOT2');
    await c.click('#startBtn');
    await c.waitForFunction(() => document.getElementById('joinErr').textContent.includes('bot'), SLOW);
    check(true, 'a bot\'s name gets an error under the form');
    await c.close();

    // issue #22: Esc takes Rosta back to the menu: he leaves the game (Petr sees him go), the start screen is back with his name in it,
    // and the start button brings him in again
    await a.keyboard.press('Escape');
    await a.waitForFunction(() => WOD.state === 'intro' && !document.getElementById('intro').hidden && !document.getElementById('startBtn').disabled, SLOW);
    await b.waitForFunction(() => ![...WOD.NET.others.values()].some(o => o.name === 'Rosta'), SLOW);
    check((await a.$eval('#nameIn', e => e.value)) === 'Rosta' && !(await a.evaluate(() => WOD.NET.live)), 'Esc takes Rosta back to the menu, his name still in the form, and Petr sees him leave');
    await a.click('#startBtn');
    await a.waitForFunction(() => WOD.state === 'drive' && WOD.NET.live, SLOW);
    await b.waitForFunction(() => [...WOD.NET.others.values()].some(o => o.name === 'Rosta' && o.on), SLOW);
    check(true, 'the start button brings Rosta back into the game, and Petr sees him again');

    // Petr leaves: Rosta's city and scoreboard lose him
    await b.close();
    await a.waitForFunction(() => ![...WOD.NET.others.values()].some(o => o.name === 'Petr'), SLOW);
    check(!(await row(a, 'Petr')), 'when Petr leaves, his tank and row go');

    // a phone: the HUD and the scoreboard fit
    const m = await player(browser, 'Mobil', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 5);
    await m.waitForFunction(() => [...WOD.NET.others.values()].filter(o => o.on).length >= 2, SLOW);
    await frames(m, 6);
    await m.screenshot({ path: path.join(OUT, '6-phone.png') });

    // software-drawn headless Chrome is the weak computer: the quality drops by itself; F shows the readout
    await a.waitForFunction(() => WOD.PERF.level === 2, SLOW);
    check(true, 'the quality drops to low by itself when the frames do not keep up');
    await a.keyboard.press('KeyF');
    await a.waitForFunction(() => /ping \d+ ms/.test(document.getElementById('stats').textContent), SLOW);
    const readout = await a.$eval('#stats', e => (e.hidden ? 'hidden: ' : '') + [...e.children].map(s => s.textContent).join(' | '));
    check(/^\d+ FPS/.test(readout) && readout.includes('nízká (auto'), `F shows FPS, ping and the level (${readout})`);
    await frames(a, 3);
    await a.screenshot({ path: path.join(OUT, '7-low-quality-readout.png') });

    for (const [n, p] of [['Rosta', a], ['Mobil', m]]) check(!p.errors.length, `no errors in ${n}'s console${p.errors.length ? ': ' + p.errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed', '\nscreenshots in', OUT);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
