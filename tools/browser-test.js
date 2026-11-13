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
// Issue #31, the loading: first, alone, Tom's page, whose textures never come, gets in with them late. Rosta's join form works before
// the game's code runs and answers his typing while the city is built behind it; his Start shows the loading screen, whose one bar
// never goes back, and he comes in with his tank away from the others and the cells round him built; Petr clicks Start before the
// game's code is there and gets in once it is; both pages build the same city; after Esc a new start waits only for the network.
// Dana's page goes back to the form in every way a start can end early (Esc before the city, Esc before the welcome, no first
// snapshot, no server, a taken name); a page without WebGL says the game cannot start. Every page notes its slow input events, long
// tasks and script downloads from its first moment, and every page but the one without WebGL must end with a clean console.
// Issue #34, the textures: every texture of every quality level is downloaded on the loading screen, so after Rosta's first moment
// in the game his page asks the server for no texture again, through three Q presses (each level's maps there at once, none a
// stand-in), a minute of driving (nothing changes) and the automatic quality's steps (each one said in the toast for at least 3 s,
// textures only as the last one, a texture step never remembered); Petr's page, which an older version left on the low level
// (wod-quality), starts on high.
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
// issue #31: the messages the loading tests expect (client/src/texts.ts, the Czech ones: the pages load without ?lang=en)
const TXT = (() => {
  const src = fs.readFileSync(path.join(__dirname, '../client/src/texts.ts'), 'utf8');
  const t = k => (new RegExp('\\b' + k + ': "([^"]+)"').exec(src) || [])[1];
  // issue #34: the quality's messages: the start of qStep and qSet (functions of a name), the auto steps' names, the levels' names
  const fn = k => (new RegExp('\\b' + k + ": \\(\\w+: string\\)=>'([^']+)'").exec(src) || [])[1];
  const list = k => JSON.parse((new RegExp('\\b' + k + ': (\\[[^\\]]+\\])').exec(src) || [])[1] || '[]');
  return { errConn: t('errConn'), noStart: t('noStart'), qStep: fn('qStep'), qSet: fn('qSet'), qLevers: list('qLevers'), qNames: list('qNames'),
    qAutoLbl: t('qAutoLbl'), qLbl: t('qLbl') };
})();
const STEPS = ['city', 'tex', 'net', 'snap', 'warm'];      // issue #31: the loading screen's steps in order (client/src/ui/loading.ts)

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
// issue #31: a start from the join form's first moment: the game's code, the city built in slices, the shaders compiled in software
// while other pages draw (a minute or more headless)
const LOADING = { timeout: 280000 };
const BLUE = 2, BLUE_HEX = 0x4d8dff;           // the third swatch
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

// World of DODO, issue #31: what every page notes from its first moment, before its own scripts run: input events slower than a
// frame (the Event Timing API; processingStart - startTime is how long a key waited for the page), the long tasks, and every script
// chunk it fetched (an observer, not the resource buffer, which stops at 250 entries)
// Issue #34: and every request for a texture or another asset (as), every change of the toast line ([ms, text, shown]) and of the
// automatic quality's step ([ms, step]), so a test can tell what the page fetched after it was in the game and what it said when.
function watch() {
  const BT = window.BT = { ev: [], lt: [], js: [], as: [], toast: [], steps: [] };
  const obs = (type, f, o) => { try { new PerformanceObserver(l => l.getEntries().forEach(f)).observe({ type, buffered: true, ...o }); } catch (_) { /* not supported */ } };
  obs('event', e => BT.ev.push([e.name, Math.round(e.startTime), Math.round(e.processingStart - e.startTime), Math.round(e.duration)]), { durationThreshold: 16 });
  obs('longtask', e => BT.lt.push([Math.round(e.startTime), Math.round(e.duration)]));
  obs('resource', e => {
    if (/\/app\/[^/]+\.js$/.test(e.name)) BT.js.push([Math.round(e.startTime), e.name.replace(/^.*\//, ''), e.decodedBodySize, Math.round(e.responseEnd)]);
    if (/\/assets\//.test(e.name)) BT.as.push([Math.round(e.startTime), e.name.replace(/^.*\/assets\//, '')]);
  });
  addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('toast'); if (!el) return;
    const note = () => { const t = el.textContent, on = !el.classList.contains('off'), l = BT.toast[BT.toast.length - 1]; if (!l || l[1] !== t || l[2] !== on) BT.toast.push([Math.round(performance.now()), t, on]); };
    new MutationObserver(note).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  setInterval(() => { const st = window.WOD && WOD.PERF ? WOD.PERF.step : undefined, l = BT.steps[BT.steps.length - 1]; if (st !== undefined && (!l || l[1] !== st)) BT.steps.push([Math.round(performance.now()), st]); }, 50);
}
// A person's browser (its own storage) on the page, watched from its first moment. ovr: issue #31's test switches (window.WOD_OVR,
// client/src/globals.d.ts), set before the page's scripts run; setup(page): anything else before it loads. Resolves once the join
// form works (LOAD.t.form; issue #31: Start works from then on, the game's code comes after it).
async function open(browser, viewport, ovr, setup) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(viewport || { width: 960, height: 600 });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.evaluateOnNewDocument(watch);
  if (ovr) await page.evaluateOnNewDocument(o => { window.WOD_OVR = o; }, ovr);
  if (setup) await setup(page);
  await page.goto(BASE + '/?test', { waitUntil: 'domcontentloaded', ...SLOW });
  await page.waitForFunction(() => window.WOD_LOAD && WOD_LOAD.t.form > 0, { ...SLOW, polling: 20 });
  return page;
}
// the join form: the name, the colour and the team (issue #24: 0 A, 1 B, or nothing for the form's default, automatic); Start
async function start(page, name, color, team) {
  await page.$eval('#nameIn', e => { e.value = ''; });
  await page.type('#nameIn', name);
  if (color !== undefined) await page.click(`#swatches input[value="${color}"]`);
  if (team !== undefined) await page.click(`input[name=team][value="${team}"]`);
  await page.click('#startBtn');
}
const inGame = page => page.waitForFunction(() => window.WOD && WOD.state === 'drive', LOADING);
// issue #31: after Start, the loading screen (it shows 250 ms after the click unless the game is in sooner) into a screenshot
async function loadingShot(page, file) {
  await page.waitForFunction(() => !document.getElementById('loading').hidden || (window.WOD && WOD.state === 'drive'), LOADING);
  const up = await page.evaluate(() => !document.getElementById('loading').hidden);
  if (up) await page.screenshot({ path: path.join(OUT, file) });
  return up;
}
async function player(browser, name, viewport, color, team, ovr) {
  const page = await open(browser, viewport, ovr);
  if (name) { await start(page, name, color, team); await inGame(page); }
  return page;
}
// a person closes the browser: nothing in its console but what allow expects (issue #31: every page is checked)
async function bye(page, who, allow) {
  const errs = page.errors.filter(e => !(allow && allow.test(e)));
  check(!errs.length, `no errors in ${who}'s console${errs.length ? ': ' + errs.join(' | ') : ''}`);
  await page.browserContext().close();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    executablePath: CHROME, headless: true, protocolTimeout: 330000,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
  });
  try {
    // issue #31, first and alone in the browser (so the shaders' pre-warm has the machine to itself and its time limit says something
    // about the textures): textures that never come (every .webp held back, their limit 3 s). Tom gets in with them late, not the
    // shaders; every city_* mesh is ready meanwhile on its stand-ins; then they come. Issue #34: and every download finishes then
    // (a held one gets no byte: its stall limit is set beyond the test, so it is neither retried nor given up meanwhile)
    {
      const held = []; let hold = true;
      const tm = await open(browser, null, { texMaxMs: 3000, stallMs: 600000 }, async p => {
        await p.setRequestInterception(true);
        p.on('request', r => { if (hold && /\/assets\/.+\.webp$/.test(new URL(r.url()).pathname)) held.push(r); else r.continue().catch(() => {}); });
      });
      await start(tm, 'Tom');
      await inGame(tm);
      const tx = await tm.evaluate(() => {
        const ms = WOD.scene.meshes.filter(m => m.name.startsWith('city_'));
        return { late: WOD_LOAD.last.late, ms: WOD_LOAD.last.ms, pwl: WOD.boot.preWarmLate, n: ms.length, notReady: ms.filter(m => !m.isReady(true)).map(m => m.name) };
      });
      check(held.length > 0 && tx.late.includes('tex') && !tx.late.includes('warm') && tx.pwl === false,
        `textures held back (${held.length}): Tom is in after ${tx.ms} ms with them late (late: ${tx.late.join()}; pre-warm late: ${tx.pwl})`);
      check(tx.n > 0 && !tx.notReady.length, `meanwhile every city_* mesh is ready on its stand-ins (${tx.n - tx.notReady.length}/${tx.n}${tx.notReady.length ? '; not: ' + tx.notReady.slice(0, 5).join(', ') : ''})`);
      hold = false; held.splice(0).forEach(r => r.continue().catch(() => {}));
      const done = await tm.waitForFunction(() => window.wodAssets && wodAssets.pending === 0, SLOW).then(() => true, () => false);
      const ta = await tm.evaluate(() => window.wodAssets && { files: wodAssets.files, failed: wodAssets.failed, pending: wodAssets.pending });
      check(done && !!ta && ta.failed === 0, `once let through, every download finishes (${JSON.stringify(ta)})`);
      await frames(tm, 3);
      await bye(tm, 'Tom');
    }

    // issue #31, the first moments: Rosta's join form works before any of the game's code runs (LOAD.t.form before eval1, the
    // engine's stage), and a name typed at once echoes while the city is still being built behind the form; then the city fades in
    // (html.city). The marks, the slowest key, the long tasks and the build's times go into the log (the budgets: the pull request).
    const a = await open(browser);
    await a.type('#nameIn', 'abc');
    const early = await a.evaluate(() => ({ v: document.getElementById('nameIn').value, city: WOD_LOAD.isDone('city') }));
    check(early.v === 'abc' && !early.city, `typed at once, the name field echoes ("${early.v}") while the city is still being built`);
    await a.screenshot({ path: path.join(OUT, '0-form-before-city.png') });
    // the slowest key must cover the whole load (the import stages, main.ts's evaluation, the build's slices, the pre-warm), not only
    // the form's first moment, before the first stage began: so Rosta keeps typing, a key every 75 ms, until the city is in (an x and
    // a Backspace: the field stays "abc", for 1-intro.png)
    const typeUntil = Date.now() + LOADING.timeout;
    for (let i = 0; Date.now() < typeUntil && !await a.evaluate(() => document.documentElement.classList.contains('city')); i++) {
      await a.keyboard.press(i % 2 ? 'Backspace' : 'KeyX'); await sleep(75);
    }
    if ((await a.$eval('#nameIn', e => e.value)) !== 'abc') await a.keyboard.press('Backspace');   // (the city came after an x)
    await a.waitForFunction(() => document.documentElement.classList.contains('city'), LOADING);
    const boot = await a.evaluate(() => ({ t: WOD_LOAD.t, ms: WOD.boot && WOD.boot.ms, longest: WOD_LOAD.longest, keys: BT.ev.filter(e => e[0] === 'keydown'), lt: BT.lt,
      pre: BT.js.filter(j => j[3] <= WOD_LOAD.t.form) }));                    // (the script downloaded before the form worked)
    const preKB = boot.pre.reduce((n, j) => n + j[2], 0) / 1024;
    check(boot.t.form < boot.t.eval1 && preKB <= 60, `the form works (${Math.round(boot.t.form)} ms) before the game's code runs (${Math.round(boot.t.eval1)} ms), on ${preKB.toFixed(1)} KB of script (${boot.pre.map(j => j[1]).join(', ')})`);
    console.log(`     marks (ms from navigation): ${Object.entries(boot.t).sort((x, y) => x[1] - y[1]).map(([k, v]) => k + ' ' + Math.round(v)).join(', ')}`);
    // (each window on its own: the import stages to the end of main.ts's evaluation, the build's slices to the city, the pre-warm after it)
    const worst = (lo, hi) => Math.max(0, ...boot.keys.filter(e => e[1] >= lo && e[1] < hi).map(e => e[2]));
    console.log(`     slowest key while loading waited ${worst(0, Infinity)} ms (the import stages ${worst(0, boot.t.code)}, the build ${worst(boot.t.code, boot.t.city)}, the pre-warm ${worst(boot.t.city, Infinity)}; ${boot.keys.length} keydowns over 16 ms); longest task from the end of the game's code's evaluation to the city ${Math.round(boot.longest)} ms`);
    console.log(`     long tasks (start+ms): ${boot.lt.map(l => l[0] + '+' + l[1]).join(' ')}`);
    console.log(`     the build (WOD.boot.ms): ${JSON.stringify(boot.ms)}`);
    await frames(a, 3);
    await a.screenshot({ path: path.join(OUT, '1-intro.png') });
    check((await a.$$('#swatches input')).length === 12, 'the join form offers 12 tank colours');
    check((await a.$$eval('input[name=team]', l => l.map(i => i.value + (i.checked ? '*' : '')).join())) === 'auto*,0,1', 'issue #24: the join form offers a team, automatic by default, A or B');

    // issue #31, his start: the loading screen, one bar that never goes back and ends full, its label going through the steps in
    // order; then the game: the screen gone, his tank away from everyone else's, no more of the game's code to fetch; the cells
    // round him were built before he came in, so standing 5 s none is built in a frame
    await start(a, 'Rosta', BLUE, 0);
    if (!await loadingShot(a, '1b-loading.png')) console.log('     (Rosta was in before the loading screen showed)');
    await inGame(a);
    const run = await a.evaluate(() => ({ trace: WOD_LOAD.trace, last: WOD_LOAD.last, gap: WOD.boot.spawnGap }));
    const ord = run.trace.map(e => STEPS.indexOf(e[2]));
    const steady = run.trace.every((e, i) => i === 0 || (e[1] >= run.trace[i - 1][1] && ord[i] >= ord[i - 1]));
    const labels = run.trace.filter((e, i) => i === 0 || e[2] !== run.trace[i - 1][2]).map(e => e[2] + ' ' + e[1] + '% @' + e[0]);
    check(steady && run.trace.length > 0 && run.trace[run.trace.length - 1][1] === 100,
      `the bar never goes back and ends full, its label through the steps in order (${labels.join(' → ')} → 100%; in after ${run.last.ms} ms, late: ${run.last.late.join() || 'none'})`);
    check(await a.waitForFunction(() => document.getElementById('loading').hidden, { timeout: 10000 }).then(() => true, () => false), 'in the game, the loading screen is gone');
    check(run.gap > 3, `Rosta's tank starts away from everyone else's (${run.gap && run.gap.toFixed(1)} units to the nearest)`);
    // issue #34: every texture of every level came on the loading screen (29 files today), none failed, none is on its way, and the
    // step was not cut short; from here on (rostaIn) his page fetches no asset again, checked at the end of his session
    const rostaIn = await a.evaluate(() => WOD_LOAD.t.open + WOD_LOAD.last.ms);
    const rAs = await a.evaluate(() => window.wodAssets && { files: wodAssets.files, got: wodAssets.got, failed: wodAssets.failed, pending: wodAssets.pending, mb: +(wodAssets.bytes / 1e6).toFixed(2) });
    check(!!rAs && rAs.files >= 29 && rAs.failed === 0 && rAs.pending === 0 && !run.last.late.includes('tex'),
      `every texture of every level is in before the game (${JSON.stringify(rAs)}; late: ${run.last.late.join() || 'none'})`);
    const in0 = await a.evaluate(() => WOD.boot.near.inFrame);
    await sleep(5000);
    const stood = await a.evaluate(() => ({ inFrame: WOD.boot.near.inFrame, js: BT.js.filter(j => j[0] > WOD_LOAD.t.open + WOD_LOAD.last.ms).map(j => j[1]) }));
    check(stood.inFrame === in0, `standing 5 s, no cell round him is built in a frame (${in0} → ${stood.inFrame})`);
    check(!stood.js.length, `no more of the game's code is fetched once he is in (${stood.js.join(', ') || 'none'})`);
    // issue #16: he starts at one of the map's spawn points, on a street of Karlín (or, with all of them taken, in the depot's yard);
    // issue #24: in his team's half (A: the west)
    const s0 = await a.evaluate(() => ({ x: WOD.car.x, z: WOD.car.z }));
    check(M.SPAWNS.some(p => Math.hypot(p.x - s0.x, p.z - s0.z) < 0.5) && M.onRoad(s0.x, s0.z) && RU.homeSide(0, s0.x) || Math.hypot(M.DEPOT.park.x - s0.x, M.DEPOT.park.z - s0.z) < 0.5,
      `Rosta starts on a street, at one of the map's spawn points, in A's half (${s0.x.toFixed(1)}, ${s0.z.toFixed(1)})`);
    // issue #31: Petr is quicker than the game's code (a slow download: WOD_OVR.importDelay holds it back 2 s, and its chunks wait
    // until he has clicked, as headless typing can take longer than that): his Start waits for the code (LOAD.pending) and gets him
    // in once it is there. (What the page's script itself needs, the page names: its script and modulepreload links.)
    const own = new Set(((await (await fetch(BASE + '/')).text()).match(/\/app\/[\w.-]+\.js/g) || []));
    let gate = true; const parked = [];
    // issue #34: and an older version left his browser on the low level (wod-quality '2': the automatic drop, remembered): he starts on
    // high all the same, and the old key is gone
    const b = await open(browser, null, { importDelay: 2000 }, async p => {
      await p.evaluateOnNewDocument(() => { try { if (!sessionStorage.getItem('bt-q')) { sessionStorage.setItem('bt-q', '1'); localStorage.setItem('wod-quality', '2'); } } catch (_) { /* no storage */ } });
      await p.setRequestInterception(true);
      p.on('request', r => { const u = new URL(r.url()).pathname; if (gate && /^\/app\/[^/]+\.js$/.test(u) && !own.has(u)) parked.push(r); else r.continue().catch(() => {}); });
    });
    await start(b, 'Petr', undefined, 1);
    const pend = await b.evaluate(() => ({ p: WOD_LOAD.t.pending, e: WOD_LOAD.t.eval1 }));
    gate = false; parked.splice(0).forEach(r => r.continue().catch(() => {}));
    check(pend.p > 0 && !(pend.e < pend.p), `Petr's Start before the game's code is there waits for it (at ${Math.round(pend.p)} ms)`);
    await inGame(b);
    const pq = await b.evaluate(() => {
      const st = WOD.scene.meshes.filter(m => m.isEnabled() && m.material && m.material.name === 'mat_asphalt' && m.subMeshes && m.subMeshes.length);
      const bump = st.map(m => { const d = m.subMeshes[0].materialDefines; return d ? !!d.BUMP : !!m.material.bumpTexture; });
      return { level: WOD.PERF.level, old: localStorage.getItem('wod-quality'), streets: st.length, bump: bump.filter(Boolean).length };
    });
    check(pq.level === 0 && pq.old === null && pq.streets > 0 && pq.bump === pq.streets,
      `Petr, left on low by an older version, starts on high: the streets have their normal maps (${pq.bump}/${pq.streets}), the old key is gone (${JSON.stringify(pq)})`);
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
    // issue #31: built in slices, between other work, the city is still the same on both pages (its props, meshes and vertices)
    const digest = await Promise.all([a, b].map(p => p.evaluate(() => WOD.boot.digest)));
    check(digest[0] !== undefined && digest[0] === digest[1], `both pages built the same city (digest ${digest[0]} | ${digest[1]})`);

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
    await bye(t, 'Tereza');

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
    // World of DODO, issue #34: the chip is drawn in the page's next frame, after the state above (TM) has changed; in software a frame
    // can take seconds, so it is waited for too, not read once (Petr's chip once read 28 % while his state said more than 30)
    const chipIn = p => p.waitForFunction(col => {
      const e = document.querySelector('#zones .zc'), i = e && e.querySelector('i');
      return !!i && (e.classList.contains('o0') || ((parseFloat(i.style.width) || 0) > 30 && i.style.getPropertyValue('--pc') === col));
    }, { timeout: 60000 }, hex(RU.TEAM_COL[0])).catch(() => {});
    if (capA && capB) await Promise.all([chipIn(a), chipIn(b)]);
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
    // Rosta's ship goes 60 to 90 down or up the river from Petr's. Velemlok or a bot may sink Petr's ship meanwhile (it comes back at
    // another spawn point, out of Rosta's range), so before each salvo Rosta is put near it again if it is far (issue #27: the heavier
    // city makes the test slower, and Velemlok was often out at this point).
    let pp = null;
    const shipSpot = async () => {
      pp = await b.evaluate(() => ({ x: WOD.car.x, z: WOD.car.z }));
      let spot = null;
      for (const d of [90, -90, 75, -75, 60, -60]) {
        const h = NV.riverDir(pp.x, pp.z), x = pp.x + Math.sin(h) * d, z = pp.z + Math.cos(h) * d;
        if (NV.inWater(x, z, 10)) { spot = { x, z, h: Math.atan2(pp.x - x, pp.z - z) }; break; }
      }
      if (!spot) return false;
      await a.evaluate(s => { Object.assign(WOD.car, { x: s.x, z: s.z, h: s.h, v: 0, immT: 0 }); WOD.sh.tel = 1; }, spot);
      await seesAt(b, spot.x, spot.z);
      await seesAt(a, pp.x, pp.z);
      return true;
    };
    check(await shipSpot(), 'a place on the river 60 to 90 from Petr\'s ship for Rosta\'s');
    const shipsApart = async () => { const [p, q] = await Promise.all([a, b].map(g => g.evaluate(() => ({ x: WOD.car.x, z: WOD.car.z })))); return Math.hypot(p.x - q.x, p.z - q.z); };
    const aimAtPetr = () => a.evaluate(f => { const o = eval(f)(), c = WOD.car, d = Math.hypot(o.x - c.x, o.z - c.z); WOD.sh.aimY = Math.atan2(o.x - c.x, o.z - c.z); WOD.sh.aimP = -Math.atan2(5.4, d); }, `(${petrShip})`);
    // one salvo at Petr's ship (both turrets loaded); true when Petr's ship registers a hit and Rosta scores at least `gain`
    const salvo = async (pretend, gain) => {
      if (await shipsApart() > 100) { await b.waitForFunction(() => WOD.car.k === 2 && WOD.car.topT === 0, SLOW); await shipSpot(); console.log('     (Petr\'s ship was moved: Rosta is put near it again)'); }
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

    // issue #31, the ways back while loading: Dana's page starts again and again (WOD_OVR changed before each start) and each time
    // ends at the join form; Petr's page notes everyone it ever had in its city and whether it ever drew them
    await b.evaluate(() => {
      window.SEEN = new Map(); const m = WOD.NET.others, set = m.set.bind(m);
      m.set = (k, v) => { if (!SEEN.has(v.name)) SEEN.set(v.name, { on: false }); return set(k, v); };
      setInterval(() => { for (const o of m.values()) if (o.on && SEEN.has(o.name)) SEEN.get(o.name).on = true; }, 50);
    });
    const seenD = () => b.evaluate(() => SEEN.get('Dana') || null);
    const losesD = () => b.waitForFunction(() => ![...WOD.NET.others.values()].some(o => o.name === 'Dana'), { timeout: 5000 }).then(() => true, () => false);
    const formOf = p => p.evaluate(() => ({
      form: !document.getElementById('intro').hidden && document.getElementById('loading').hidden && !WOD_LOAD.isOpen() && !document.getElementById('joinForm').inert,
      state: window.WOD ? WOD.state : null, wsGone: !!window.WOD && WOD.NET.ws === null, inGame: window.WOD ? WOD.NET.inGame : null,
      err: document.getElementById('joinErr').hidden ? '' : document.getElementById('joinErr').textContent }));
    // one more start with these switches (B reads them at each start); ended: that start is over (Esc, or failed)
    const again = async (p, ovr) => {
      const t0 = await p.evaluate(o => { window.WOD_OVR = o; return WOD_LOAD.t.open || 0; }, ovr);
      await p.click('#startBtn');
      return t0;
    };
    const ended = (p, t0) => p.waitForFunction(t => WOD_LOAD.t.open > t && !WOD_LOAD.isOpen(), LOADING, t0).then(() => true, () => false);
    // (a) Start at once, Esc while the game's code runs and the city is not built yet: the form, the page in the intro; it never
    // connected, so Petr never had her
    const d = await open(browser);
    await start(d, 'Dana');
    const early2 = await d.waitForFunction(() => window.WOD_EVAL === 3 && !WOD_LOAD.isDone('city') && performance.now() - WOD_LOAD.t.open > 400, { ...LOADING, polling: 20 }).then(() => true, () => false);
    await d.keyboard.press('Escape');
    await d.waitForFunction(() => !WOD_LOAD.isOpen() && window.WOD && WOD.state === 'intro', { timeout: 30000 }).catch(() => {});
    const fa = await formOf(d), tda = await d.evaluate(() => ({ city: WOD_LOAD.t.city, esc: WOD_LOAD.t.cancel }));
    await sleep(3000);
    check(early2 && fa.form && fa.state === 'intro' && tda.esc > 0 && !(tda.city < tda.esc) && !(await seenD()),
      `Esc while the game's code runs, before the city: Dana is back at the form (${JSON.stringify(fa)}), and Petr never had her`);
    // (b) the welcome held back: an open socket, Petr has her (not drawn); Esc: the form, the socket closed, Petr loses her
    await again(d, { hold: 'welcome' });
    const inB = await d.waitForFunction(() => WOD.NET.ws && WOD.NET.ws.readyState === 1, LOADING).then(() => b.waitForFunction(() => SEEN.has('Dana'), SLOW)).then(() => true, () => false);
    await d.keyboard.press('Escape');
    await d.waitForFunction(() => !WOD_LOAD.isOpen(), { timeout: 30000 }).catch(() => {});
    const fb = await formOf(d), lostB = await losesD(), sbD = await seenD();
    check(inB && fb.form && fb.state === 'intro' && fb.wsGone && lostB && sbD && !sbD.on,
      `Esc before the welcome: Dana is back at the form, her socket closed (${JSON.stringify(fb)}); Petr had her, never drew her, lost her within 5 s (${lostB})`);
    await b.evaluate(() => SEEN.delete('Dana'));
    // (c) welcomed, but no snapshot comes (its limit 1.5 s): the form with "the server cannot be reached", out of the game; Petr loses her
    let t0 = await again(d, { hold: 'snap', snapMs: 1500 });
    const inC = await b.waitForFunction(() => SEEN.has('Dana'), SLOW).then(() => true, () => false);
    await ended(d, t0);
    const fc = await formOf(d), lostC = await losesD();
    check(inC && fc.form && fc.err === TXT.errConn && fc.inGame === false && lostC,
      `no first snapshot: Dana is back at the form with "${fc.err}" (${JSON.stringify(fc)}), and Petr lost her within 5 s (${lostC})`);
    // (d) no server there: the form with "the server cannot be reached"
    t0 = await again(d, { ws: 'ws://127.0.0.1:9/ws' });
    await ended(d, t0);
    const fd = await formOf(d);
    check(fd.form && fd.err === TXT.errConn, `no server: Dana is back at the form with "${fd.err}"`);
    // (e) names: a taken one (the server refuses it) and a bot's one (the form does) get an error under the form
    await d.$eval('#nameIn', e => { e.value = ''; });
    await d.type('#nameIn', 'petr');
    t0 = await again(d, {});
    await ended(d, t0);
    await d.waitForFunction(() => !document.getElementById('joinErr').hidden, SLOW);
    check((await d.$eval('#joinErr', e => e.textContent)).includes('jméno'), 'a taken name gets an error under the form');
    await d.$eval('#nameIn', e => { e.value = ''; });
    await d.type('#nameIn', 'BOT2');
    await d.click('#startBtn');
    await d.waitForFunction(() => document.getElementById('joinErr').textContent.includes('bot'), SLOW);
    check(true, 'a bot\'s name gets an error under the form');
    await bye(d, 'Dana', /127\.0\.0\.1:9\b/);                         // (the browser reports (d)'s refused socket)

    // issue #31: without WebGL the start button says the game cannot run here and stays off; Start opens nothing
    {
      const n = await open(browser, null, null, p => p.evaluateOnNewDocument(() => { HTMLCanvasElement.prototype.getContext = () => null; }));
      await n.type('#nameIn', 'Nora');
      const said = await n.waitForFunction(s => document.getElementById('startLbl').textContent === s && document.getElementById('startBtn').disabled, LOADING, TXT.noStart).then(() => true, () => false);
      await n.click('#startBtn');
      await n.$eval('#joinForm', f => f.requestSubmit());              // (a submit in spite of the disabled button)
      await sleep(500);
      const opened = await n.evaluate(() => WOD_LOAD.isOpen() || !document.getElementById('loading').hidden || !!window.WOD);
      check(said && !opened, `no WebGL: the start button says "${await n.$eval('#startLbl', e => e.textContent)}" and Start opens nothing`);
      await n.browserContext().close();                                // (its console has the engine's error: not checked)
    }

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
    // issue #31: the city and the textures were there already and the city was built once: the new start waited for the network only
    const anew = await a.evaluate(() => ({ last: WOD_LOAD.last, builds: WOD.boot.builds }));
    check(anew.last.pre.includes('city') && anew.last.pre.includes('tex') && !anew.last.pre.includes('net') && anew.builds === 1,
      `the new start waits only for the network (done before it: ${anew.last.pre.join()}; the city built ${anew.builds}×; in after ${anew.last.ms} ms)`);

    // Petr leaves: Rosta's city and scoreboard lose him
    await bye(b, 'Petr');
    await a.waitForFunction(() => ![...WOD.NET.others.values()].some(o => o.name === 'Petr'), SLOW);
    check(!(await row(a, 'Petr')), 'when Petr leaves, his tank and row go');

    // a phone: the HUD and the scoreboard fit
    const m = await open(browser, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await start(m, 'Mobil', 5);
    await loadingShot(m, '6a-phone-loading.png');                      // issue #31: the loading screen on a phone
    await inGame(m);
    await m.waitForFunction(() => [...WOD.NET.others.values()].filter(o => o.on).length >= 2, SLOW);
    await frames(m, 6);
    await m.screenshot({ path: path.join(OUT, '6-phone.png') });

    // issue #34, the automatic quality (game/quality.ts): software-drawn headless Chrome is the weak computer, so Rosta's page has
    // stepped down by itself while he played (BT.steps, from his first moment): the resolution and the shadows first, the textures
    // only as the fifth and last step. Each step down was said in the toast (a qStep message, BT.toast) and stayed there at least
    // 3 s, whatever zone or depot news came meanwhile; F lists the steps; the step remembered for the next visit is never the
    // textures' (wod-q: a <= 4). (Before the Q presses below: Q turns the automatic quality off for the visit.)
    const top = await a.waitForFunction(() => WOD.PERF.step >= 5, SLOW).then(() => true, () => false);
    const au = await a.evaluate(() => ({ steps: BT.steps, toast: BT.toast, q: localStorage.getItem('wod-q'), now: Math.round(performance.now()) }));
    // (from the step on: drawn in software, with other pages loading beside it, a frame can take seconds, and the toast shows the
    // message only in the next one; what matters is that nothing else takes its place within 3 s of the step)
    const downs = au.steps.filter((x, i) => i > 0 && x[1] > au.steps[i - 1][1]);
    const said = downs.map(([t, k], j) => {
      const until = j + 1 < downs.length ? downs[j + 1][0] : au.now;
      const i = au.toast.findIndex(x => x[0] >= t - 1000 && x[0] < until && x[2] && x[1].startsWith(TXT.qStep));
      if (i < 0) return { k, ms: -1 };
      const next = au.toast.slice(i + 1).find(x => x[1] !== au.toast[i][1] || !x[2]);
      return { k, ms: (next ? next[0] : au.now) - t };
    });
    let wq = null; try { wq = JSON.parse(au.q); } catch (_) { /* not JSON */ }
    // (a step that changes nothing for the preset is passed over: at a pixel ratio of 1 the first one, a1, lowers no resolution)
    const t5 = downs.findIndex(x => x[1] === 5), before5 = t5 > 0 ? downs[t5 - 1][1] : t5 === 0 ? 0 : -1;
    check(top && before5 === 4 && said.every(x => x.ms >= 3000),
      `the quality stepped down by itself, the textures last (${au.steps.map(x => x[1]).join(' → ')}), each step said in the toast for 3 s or more (${said.map(x => 'a' + x.k + ' ' + x.ms + ' ms').join(', ') || 'no step'})`);
    check(!!wq && wq.a <= 4 && wq.m === 0, `the textures' step is not remembered for the next visit (wod-q ${au.q})`);
    await a.keyboard.press('KeyF');
    await a.waitForFunction(() => /ping \d+ ms/.test(document.getElementById('stats').textContent), SLOW);
    const readout = await a.$eval('#stats', e => (e.hidden ? 'hidden: ' : '') + [...e.children].map(s => s.textContent).join(' | '));
    check(/^\d+ FPS/.test(readout) && readout.includes(TXT.qLbl + ': ' + TXT.qNames[0]) && readout.includes(TXT.qAutoLbl) && readout.includes(TXT.qLevers[4]),
      `F shows FPS, ping, the level and the automatic steps taken (${readout})`);
    await frames(a, 3);
    await a.screenshot({ path: path.join(OUT, '7-quality-readout.png') });
    await a.keyboard.press('KeyF');

    // issue #34, Q: the first press after the automatic steps brings the preset back as it was (high, the steps undone); then three
    // presses go to medium, low and high again. Each change takes its maps from what the loading screen downloaded (no request: the
    // check at the end), and once its uploads are done (matlib's queue empty, nothing waiting) no material in use on high shows a
    // stand-in (a 1x1 map) and the library's colour maps are filtered at anisotropy 4; each press says what it chose (qSet).
    // (In a tank: in a ship Q fires the torpedoes.)
    const settled = p => p.waitForFunction(() => window.wodMat.queued() === 0 && WOD.scene.getWaitingItemsCount() === 0, SLOW).then(() => true, () => false);
    const inUse = p => p.evaluate(() => {
      const seen = new Set(), out = { maps: 0, stand: [], aniso: [] };
      for (const me of WOD.scene.meshes) {
        const m = me.material; if (!m || !me.isEnabled() || seen.has(m) || !/^(mat_|weather$|glass$|roof)/.test(m.name)) continue; seen.add(m);
        const pl = m.pluginManager && m.pluginManager.getPlugin('WodSurface');
        for (const [k, t] of [['c', m.diffuseTexture], ['n', m.bumpTexture], ['a', pl && pl.alt]]) {
          if (!t) continue; out.maps++;
          const z = t.getSize(); if (z.width <= 1 && z.height <= 1) out.stand.push(m.name + '.' + k);
          if (k === 'c' && m.name.startsWith('mat_') && t.anisotropicFilteringLevel !== 4) out.aniso.push(m.name + ' ' + t.anisotropicFilteringLevel);
        }
      }
      return out;
    });
    check((await a.evaluate(() => WOD.car.k)) === 0, 'Rosta is in his tank for the Q presses');
    const presses = [];
    // (the toast is read as soon as it changes: the uploads of a level, one a frame, take longer in software than its 3.5 s)
    const press = async want => {
      const n0 = await a.evaluate(() => BT.as.length);
      await a.keyboard.press('KeyQ');
      const said = await a.waitForFunction((s, n) => { const t = document.getElementById('toast').textContent; return t.startsWith(s) && t.includes(n) ? t : ''; },
        { timeout: 30000 }, TXT.qSet, TXT.qNames[want]).then(h => h.jsonValue(), () => '');
      const ok = await a.waitForFunction(l => WOD.PERF.level === l && WOD.PERF.step === 0, { timeout: 30000 }, want).then(() => true, () => false) && await settled(a);
      await frames(a, 3);
      const r = await a.evaluate(n => ({ level: WOD.PERF.level, reqs: BT.as.length - n }), n0);
      presses.push(r.level + ' "' + (said || 'no message') + '" ' + r.reqs + ' req');
      return ok && r.reqs === 0 && !!said;
    };
    const restored = (await a.evaluate(() => WOD.PERF.step)) > 0 ? await press(0) : true;
    const cycled = [await press(1), await press(2), await press(0)];
    const hi = await inUse(a);
    check(restored && cycled.every(Boolean) && hi.maps > 0 && !hi.stand.length && !hi.aniso.length,
      `Q: the preset back, then medium, low and high, each with no request and said in the toast (${presses.join('; ')}); on high again ${hi.maps} maps in use, stand-ins: ${hi.stand.join(', ') || 'none'}, anisotropy not 4: ${hi.aniso.join(', ') || 'none'}`);

    // issue #34, what the players reported: a minute of driving with the automatic quality off, forward along the streets (put on
    // the next spawn point when stuck), a sample every 2 s: the level, every library material's colour map and the count of
    // stand-ins in use never change, and there is no stand-in
    await a.evaluate(() => { WOD.PERF.auto = false; WOD.K.up = true; });
    const sample = () => a.evaluate(() => {
      const c = WOD.scene.materials.filter(m => m.name.startsWith('mat_')).map(m => { const t = m.diffuseTexture; return m.name + '=' + (!t ? '-' : t.getSize().width <= 1 ? '1x1' : String(t.url || '').replace(/^.*\//, '')); }).sort().join();
      let stand = 0;
      for (const me of WOD.scene.meshes) {
        const m = me.material; if (!m || !me.isEnabled() || !/^(mat_|weather$|glass$|roof)/.test(m.name)) continue;
        for (const t of [m.diffuseTexture, m.bumpTexture]) if (t && t.getSize().width <= 1 && t.getSize().height <= 1) stand++;
      }
      return { level: WOD.PERF.level, step: WOD.PERF.step, c, stand, x: WOD.car.x, z: WOD.car.z };
    });
    const s0q = await sample(), drift = []; let prev = s0q, moved = 0, jumps = 0;
    for (const until = Date.now() + 60000; Date.now() < until;) {
      await sleep(2000);
      const q = await sample();
      if (q.level !== s0q.level || q.step !== s0q.step || q.c !== s0q.c || q.stand !== s0q.stand || q.stand) drift.push(Math.round((until - 60000 - Date.now()) / -1000) + ' s: level ' + q.level + ', step ' + q.step + ', stand-ins ' + q.stand + (q.c !== s0q.c ? ', maps changed' : ''));
      const d = Math.hypot(q.x - prev.x, q.z - prev.z); moved += d;
      if (d < 0.5) { const sp = M.SPAWNS[jumps++ % M.SPAWNS.length]; await place(a, sp.x, sp.z, sp.h); await a.evaluate(() => { WOD.K.up = true; }); }
      prev = q;
    }
    await a.evaluate(() => { WOD.K.up = false; WOD.car.v = 0; });
    check(!drift.length && !s0q.stand, `a minute of driving: the textures stay as they are (${moved.toFixed(0)} units driven, ${jumps} jump(s) to a spawn point; ${drift.slice(0, 4).join('; ') || 'no change'})`);

    // issue #34: after his first moment in the game Rosta's page fetched no texture or other asset: not through the automatic steps,
    // the Q presses, the minute of driving, nor his new start after Esc
    const lateAs = await a.evaluate(t => BT.as.filter(x => x[0] > t).map(x => x[1]), rostaIn);
    check(!lateAs.length, `after his first moment in the game Rosta's page fetched no asset (${lateAs.length}${lateAs.length ? ': ' + lateAs.slice(0, 5).join(', ') : ''})`);

    for (const [n, p] of [['Rosta', a], ['Mobil', m]]) check(!p.errors.length, `no errors in ${n}'s console${p.errors.length ? ': ' + p.errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed', '\nscreenshots in', OUT);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
