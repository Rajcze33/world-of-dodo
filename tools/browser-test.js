// Browser test of World of DODO: two players in headless Chrome pick a name and a colour, start on a street of Karlín, see each
// other and the bots and the same city, a tank slides along a wall instead of sticking to it, a car one of them shoves
// is his for the other too, one shoots the other, the points show in both scoreboards, and a hit that destroys
// the tank brings it back somewhere else, then he takes a plane, flies, and the other's anti-aircraft gun hits it; then both take
// a ship on the Vltava (issue #20), one's shells hit the other's ship, and a hit 15 s old still counts towards sinking it.
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

const BASE = (process.argv[2] || 'http://localhost:3400').replace(/\/$/, '');
const OUT = process.argv[3] || path.join(process.cwd(), 'test-shots');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SLOW = { timeout: 120000 };
const BLUE = 2, BLUE_HEX = 0x4d8dff;           // the third swatch
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

async function player(browser, name, viewport, color) {
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
    await intro.close();

    const a = await player(browser, 'Rosta', null, BLUE);
    // issue #16: he starts at one of the map's spawn points, on a street of Karlín (or, with all of them taken, in the depot's yard)
    const s0 = await a.evaluate(() => ({ x: WOD.car.x, z: WOD.car.z }));
    check(M.SPAWNS.some(p => Math.hypot(p.x - s0.x, p.z - s0.z) < 0.5) && M.onRoad(s0.x, s0.z) || Math.hypot(M.DEPOT.park.x - s0.x, M.DEPOT.park.z - s0.z) < 0.5,
      `Rosta starts on a street, at one of the map's spawn points (${s0.x.toFixed(1)}, ${s0.z.toFixed(1)})`);
    const b = await player(browser, 'Petr');
    check((await a.evaluate(() => WOD.NET.color)) === BLUE_HEX, 'Rosta drives the blue tank he picked');
    await a.waitForFunction(() => [...WOD.NET.others.values()].some(o => o.name === 'Petr' && o.on), SLOW);
    check(true, 'Rosta sees Petr\'s tank in the city');
    const botsSeen = await a.evaluate(() => [...WOD.NET.others.values()].filter(o => o.bot).map(o => o.name).sort().join());
    check(botsSeen === 'BOT1,BOT2,BOT3', `Rosta sees the bots (${botsSeen})`);
    check((await a.$eval('#online', e => e.textContent)) === '2 online', 'the HUD says 2 online (the bots do not count)');

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
    await place(a, DUEL.ax, DUEL.az, DUEL.h);
    await place(b, DUEL.bx, DUEL.bz, DUEL.h + Math.PI);
    await Promise.all([seesAt(a, DUEL.bx, DUEL.bz), seesAt(b, DUEL.ax, DUEL.az)]);
    await Promise.all([frames(a, 12), frames(b, 12)]);
    await a.screenshot({ path: path.join(OUT, '2-rosta-sees-petr.png') });
    await b.screenshot({ path: path.join(OUT, '3-petr-sees-rosta.png') });

    // names only in plain sight: on the open street Petr is spotted; at two spawn points with houses between them (issue #16: HIDE,
    // found in the map) he is not
    const petr = () => [...WOD.NET.others.values()].find(o => o.name === 'Petr');
    await a.waitForFunction(`(${petr})().tag.visible`, SLOW);
    check(true, 'Petr\'s name shows while he is in plain sight');
    check(!!HIDE, 'two spawn points with houses between them');
    await place(b, HIDE.bx, HIDE.bz, HIDE.bh);
    await seesAt(a, HIDE.bx, HIDE.bz);
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
    check(true, 'Petr comes back at another place');
    check(await b.evaluate(() => WOD.car.immT > 0), 'and is immune for a moment after it');
    await frames(b, 4);
    await b.screenshot({ path: path.join(OUT, '5-petr-respawned.png') });

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
