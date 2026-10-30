// Browser test of World of DODO: two players in headless Chrome pick a name and a colour, see each other and
// the bots, one shoots the other, the points show in both scoreboards, and a hit that destroys the tank
// brings it back somewhere else. Saves screenshots for a look by eye.
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
const fresh = (page, hits = 0) => page.evaluate(n => Object.assign(WOD.car, { immT: 0, topT: 0, roll: 0, slowT: 0, hitLog: Array(n).fill(performance.now()) }), hits);
const row = (page, name) => page.$$eval('#board li', (lis, name) => lis.map(li => [li.querySelector('.nm').textContent, li.querySelector('b').textContent]).find(r => r[0] === name), name);
// wait until this page draws the other player's tank near (x,z)
const seesAt = (page, x, z) => page.waitForFunction((x, z) => [...WOD.NET.others.values()].some(o => !o.bot && o.on && Math.hypot(o.x - x, o.z - z) < 1), SLOW, x, z);
// a few rendered frames, so the camera and the HUD catch up
const frames = (page, n) => page.evaluate(n => new Promise(r => { const f = () => (--n > 0 ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); }), n);

// Rosta fires one parcel at Petr, who stands 26 units in front of him; resolves to Rosta's points after it
async function shoot(a, b, petrHits) {
  await place(a, 0, -60, 0);
  await place(b, 0, -34, Math.PI);
  await fresh(b, petrHits);
  const before = await a.evaluate(() => WOD.NET.pts), sid = await a.evaluate(() => WOD.NET.sid);
  await a.evaluate(() => { WOD.K.fire = true; });
  await a.waitForFunction(s => WOD.NET.sid > s, SLOW, sid);
  await a.evaluate(() => { WOD.K.fire = false; });
  await a.waitForFunction(p => WOD.NET.pts > p, { timeout: 25000 }, before).catch(() => {});
  return a.evaluate(() => WOD.NET.pts);
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
    const b = await player(browser, 'Petr');
    check((await a.evaluate(() => WOD.NET.color)) === BLUE_HEX, 'Rosta drives the blue tank he picked');
    await a.waitForFunction(() => [...WOD.NET.others.values()].some(o => o.name === 'Petr' && o.on), SLOW);
    check(true, 'Rosta sees Petr\'s tank in the city');
    const botsSeen = await a.evaluate(() => [...WOD.NET.others.values()].filter(o => o.bot).map(o => o.name).sort().join());
    check(botsSeen === 'BOT1,BOT2,BOT3', `Rosta sees the bots (${botsSeen})`);
    check((await a.$eval('#online', e => e.textContent)) === '2 online', 'the HUD says 2 online (the bots do not count)');

    // Rosta and Petr on the street through the middle of the city, 26 units apart, facing each other
    await place(a, 0, -60, 0);
    await place(b, 0, -34, Math.PI);
    await Promise.all([seesAt(a, 0, -34), seesAt(b, 0, -60)]);
    await Promise.all([frames(a, 12), frames(b, 12)]);
    await a.screenshot({ path: path.join(OUT, '2-rosta-sees-petr.png') });
    await b.screenshot({ path: path.join(OUT, '3-petr-sees-rosta.png') });

    // one hit: 10 points
    let pts = 0;
    for (let i = 0; i < 8 && !pts; i++) {
      pts = await shoot(a, b, 0);
      console.log(`     parcel ${i + 1}: ${pts ? 'hit' : 'missed'}`);
    }
    check(pts === 10, `a hit on Petr gives Rosta 10 points (${pts})`);
    await b.waitForFunction(p => [...document.querySelectorAll('#board li')].some(li => li.querySelector('.nm').textContent === 'Rosta' && li.querySelector('b').textContent === String(p)), SLOW, pts);
    const ra = await row(a, 'Rosta'), rb = await row(b, 'Rosta');
    check(ra && rb && ra[1] === '10' && rb[1] === '10', 'both scoreboards show Rosta with 10');
    check((await a.$eval('#myPts', e => e.textContent)) === '10', 'Rosta\'s own points counter says 10');

    // the hit that destroys Petr (he had two recent hits): an explosion, and Petr comes back elsewhere
    let killed = false;
    for (let i = 0; i < 8 && !killed; i++) {
      const before = pts;
      pts = await shoot(a, b, 2);
      killed = pts > before && (await b.evaluate(() => WOD.car.topT > 0 || Math.hypot(WOD.car.x, WOD.car.z + 34) > 20));
      console.log(`     parcel ${i + 1}: ${killed ? 'destroyed Petr' : 'no kill yet'}`);
    }
    check(killed, 'the third hit destroys Petr\'s tank');
    await Promise.all([frames(a, 3), frames(b, 3)]);
    await a.screenshot({ path: path.join(OUT, '4-rosta-destroys-petr.png') });
    await b.waitForFunction(() => WOD.car.topT === 0 && Math.hypot(WOD.car.x, WOD.car.z + 34) > 20, SLOW);
    check(true, 'Petr comes back at another place');
    check(await b.evaluate(() => WOD.car.immT > 0), 'and is immune for a moment after it');
    await frames(b, 4);
    await b.screenshot({ path: path.join(OUT, '5-petr-respawned.png') });

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

    // Petr leaves: Rosta's city and scoreboard lose him
    await b.close();
    await a.waitForFunction(() => ![...WOD.NET.others.values()].some(o => o.name === 'Petr'), SLOW);
    check(!(await row(a, 'Petr')), 'when Petr leaves, his tank and row go');

    // a phone: the HUD and the scoreboard fit
    const m = await player(browser, 'Mobil', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 5);
    await m.waitForFunction(() => [...WOD.NET.others.values()].filter(o => o.on).length >= 2, SLOW);
    await frames(m, 6);
    await m.screenshot({ path: path.join(OUT, '6-phone.png') });

    for (const [n, p] of [['Rosta', a], ['Mobil', m]]) check(!p.errors.length, `no errors in ${n}'s console${p.errors.length ? ': ' + p.errors.join(' | ') : ''}`);
  } finally {
    await browser.close();
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed', '\nscreenshots in', OUT);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
