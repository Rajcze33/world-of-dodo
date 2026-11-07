// World of DODO in the browser: the boot, the way into the game, and the frame loop (the order of the updates, the camera, the light).
//
// World of DODO, issue #31: this module is the game's last import stage (entry.ts: the page's light first script has put the texts in
// and made the join form work; core/engine.ts and the map are loaded already). It builds the city in slices behind the form (the
// boot), then makes the shaders ready (the pre-warm) and only then starts drawing the intro's orbit. A Start opens the loading screen
// (ui/loading.ts), and startRun takes the game through its steps (the city, the textures, the connection, the first snapshot, the
// shaders) into it; abortRun is the one way back to the form (Cancel, Esc, a failure, the menu). core/evalmark3.ts comes first: it
// tells entry.ts that this stage was downloaded and began to run.
import './core/evalmark3';
import type { Vector3, TransformNode } from '@babylonjs/core';
import { engine, scene, camera, lookAt, moonAt, resize, aspect, setFog } from './core/engine';
import { TEXREG } from './core/tex';
import { $, COARSE } from './core/dom';
import { T } from './texts';
import { G, car, K, HELD, input, view } from './game/state';
import { groundH, segHit, free, AIR_LIM, DATA } from './world/grid';
import { drawMap, sizeMini, mini, mctx } from './ui/minimap';
import { initInput, releaseMouse, mouseLocked } from './game/input';
import { PERF, setQuality, initQuality, perfTick, perfReset } from './game/quality';
import { buildCity, finishCity, CRANE_TOP } from './world/city';
import { updateProps, PROPS } from './world/props';
import { buildTraffic, updateTraffic, TRAFFIC, PARKED } from './world/traffic';
import { buildPeds, updatePeds, PEDS } from './world/peds';
import { buildTank, updateDrive, reset, respawn, moveTank, paintMat, vanOwnMat, camLook, switchVehicle, vehName } from './game/tank';
import { buildShots, updateShots } from './game/shots';
import { buildBullets, updateBullets } from './game/bullets';
import { buildPlane, updateFly, planeView, planeCam, drawReticle, pl, KMH, M_PER_U } from './game/plane';
import { buildShip, updateShip, shipView, shipCam, drawShipHud, seaHud, sh, KNOTS } from './game/ship';
import { buildShells, updateShells } from './game/shells';
import { buildFx, updateImpactFx, updateSnow, fx } from './game/fx';
import { buildLand } from './world/land';
import { buildWater, updateWater } from './world/water';
import { WATER_Y, SHIP_SPAWNS, inWater } from '../shared/naval.ts';
import { NET, netUpdate, netConnect, netLeave, serverNow } from './net/net';
import { toast, flashMsg, flashUntil, noStart } from './ui/hud';
import { now } from './core/util';
import { WORLD, worldUpdate, worldAt, BODIES, buildNet } from './net/world';
import { buildObjectives, updateObjectives } from './world/objectives';
import { buildTeamHud, teamHud } from './ui/teamhud';
import { TM, teamsWelcome, flagTeam, friendly, zoneP } from './game/teams';
import { ZONES, DEPOTS, zoneAt } from '../shared/rules.ts';
import { buildMonster, monModel, monFxCount } from './world/monster';
import { MON, monStep, monMapPose } from './game/monster';
import { monHud, monHudOff, placeMonTag } from './ui/monhud';
import { LOAD, CITY_CODE, type FailHow } from './ui/loading';
import { JOIN, JOIN_HOOK, type Join } from './ui/join';
import { run, yieldNow, SLICE, SLICE_MS, type Work } from './core/slice';
import { nearAround, NEAR } from './world/facade';
import { matIssued, startUploads, stopUploads } from './core/matlib';

const TEST = new URLSearchParams(location.search).has('test');

// ---------- loop ----------
// camLook (game/tank.ts): the point the camera looks at, eased like the camera itself; reset and respawn put it on the tank
let last = performance.now(), orbit = 0, paused = document.hidden;
// World of DODO, issue #16: the intro circles Karlínské náměstí with the church of sv. Cyril a Metoděj (the map's landmark), the middle
// of the real Karlín as people know it; the old invented city was simply centred on 0, 0
const INTRO = DATA.landmarks.church || { x: 0, z: 0 };
// World of DODO, issue #31: the camera on the intro's orbit at once (at the boot, and back from a start): reset() puts it behind the
// tank at the depot, and gliding up from there the intro's first frames would bring the houses' near detail round the depot (world/
// facade.ts bakeCells builds every cell near the camera in the frame it comes near)
function introCam() {
  const r = 210; camera.position.set(INTRO.x + Math.cos(orbit) * r, 95, INTRO.z + Math.sin(orbit) * r); camLook.set(INTRO.x, 0, INTRO.z);
}
// three's v.lerp(target, a), without a new vector every frame
function lerpTo(v: Vector3, x: number, y: number, z: number, a: number) { v.x += (x - v.x) * a; v.y += (y - v.y) * a; v.z += (z - v.z) * a; }
// the window's size: the 3D view (and its lens, wider on a portrait screen) and the minimap's canvas
function onResize() { resize(); sizeMini(); }
// World of DODO, issue #31: frames to draw while loading (the warm frames, startRun); the first frame drawn at all fades the 3D view in
let warmFrames = 0, drawn = false;

function frame() {
  if (paused) return;
  const tnow = performance.now(), raw = tnow - last, dt = Math.min(0.05, raw / 1000); last = tnow;
  // World of DODO: a tank, a plane (#14) or a ship (#20)
  if (G.state === 'drive') { if (car.k === 1) updateFly(dt); else if (car.k === 2) updateShip(dt); else updateDrive(dt); G.realSec += dt; }
  if (WORLD.on) worldUpdate(dt, tnow); else { updateTraffic(dt); updatePeds(dt); }   // World of DODO: once you play, the city comes from the server
  monStep(dt);                                                     // issue #26: Velemlok (before the projectiles: they hit it where it is drawn)
  updateShots(dt); updateBullets(dt); updateShells(dt); updateProps(dt); updateObjectives(dt, tnow);   // (issue #24: the zones' flags, the depots)
  // World of DODO, issue #31: while loading the world goes on (the server's city, the round, the others below) but nothing is drawn: the
  // loading screen covers the page, a drawn frame would take its time from the work in slices, and before the spawn the near detail
  // (world/facade.ts bakeCells) would build every cell round the depot in one frame. Only the last few frames are drawn (warmFrames).
  if (G.state === 'load' && warmFrames <= 0) { netUpdate(dt, tnow); return; }
  // the player's tank (still called van, as in the original); makeTank keeps its wheels (none spin any more) and the body that rolls
  // with the steering in metadata (three's userData)
  const van = view.van!, parts = van.metadata as { wheels?: TransformNode[]; body?: TransformNode } | null;
  if (car.k === 0) car.gy += (groundH(car.x, car.z) - car.gy) * Math.min(1, dt * 14);
  van.position.set(car.x, car.gy + 0.9 * Math.abs(Math.sin(car.roll)), car.z); van.rotation.y = car.h; van.rotation.z = car.roll;
  van.setEnabled(car.k === 0 && !(G.state === 'drive' && car.immT > 0 && Math.floor(tnow / 110) % 2));   // World of DODO: blinks while immune after a (re)spawn
  planeView(dt, tnow); shipView(dt, tnow);
  parts?.wheels?.forEach(w => { w.rotation.x += car.v * dt / 0.46; });
  if (parts?.body) parts.body.rotation.z = -car.steer * Math.min(1, Math.abs(car.v) / 20) * 0.05;

  // camera
  const k = 1 - Math.exp(-dt * 4);
  if (G.state === 'intro') {                                       // the intro orbits the city (round its square, issue #16)
    orbit += dt * 0.05; const r = 210;
    lerpTo(camera.position, INTRO.x + Math.cos(orbit) * r, 95, INTRO.z + Math.sin(orbit) * r, Math.min(1, k * 0.5)); lerpTo(camLook, INTRO.x, 0, INTRO.z, Math.min(1, k * 0.5));
  } else if (car.k === 1) planeCam(dt);                             // World of DODO, issue #14: behind the plane, along the mouse's aim
  else if (car.k === 2) shipCam(dt);                               // World of DODO, issue #20: round the ship, along the mouse's aim
  else {                                                         // behind the tank, or high above it (camMode); farther and higher on a portrait screen
    const pt = aspect() < 1, back = G.camMode ? (pt ? 30 : 24) : (pt ? 14 : 11.5), up = G.camMode ? (pt ? 36 : 28) : (pt ? 7.8 : 5.4), ah = pt ? 7 : 4;
    const hx = Math.sin(car.h), hz = Math.cos(car.h);                 // the tank's heading
    // World of DODO: a wall or a container between the tank and the camera pulls the camera in front of it (and a little higher)
    const cx = car.x - hx * back, cz = car.z - hz * back, hit = segHit(car.x, 1.6, car.z, cx, up, cz), pull = hit < 1 ? Math.max(0.2, hit - 0.08) : 1;
    lerpTo(camera.position, car.x + (cx - car.x) * pull, 1.6 + (up - 1.6) * pull + (1 - pull) * 3, car.z + (cz - car.z) * pull, hit < 1 ? Math.min(1, k * 3) : k);
    lerpTo(camLook, car.x + hx * ah, 1.2, car.z + hz * ah, Math.min(1, k * 2));
  }
  // the lens (wider on a portrait screen, core/engine.ts resize); World of DODO, issue #20: narrower through a ship's binoculars
  const lens = (innerWidth < innerHeight ? 72 : 55) * Math.PI / 180 / (G.state === 'drive' && car.k === 2 ? sh.zk : 1);
  if (camera.fov !== lens) camera.fov = lens;
  lookAt(camLook);

  // light follows the action: the shadow box around the tank (wider under a plane, the light above it), or around the whole city in the
  // intro; the fog farther in the air (issue #20: and on the river, where the guns reach 320)
  const wide = G.state === 'intro', air = !wide && car.k === 1, sea = !wide && car.k === 2;
  moonAt(wide ? INTRO.x : car.x, wide ? INTRO.z : car.z, wide ? 190 : air ? 110 : 80, air ? Math.max(110, car.y + 40) : 110);
  setFog(air || sea);

  // snow, and the river's effects (wakes, splashes; world/water.ts)
  updateSnow(dt, tnow); updateWater(dt);
  if (CRANE_TOP) CRANE_TOP.rotation.y = tnow * 0.00005;           // World of DODO: the crane turns slowly (a turn in about two minutes)

  netUpdate(dt, tnow);
  placeMonTag();                                                   // issue #26: Velemlok's hit points over it (the camera has moved)
  if (G.state === 'drive') {
    $('spd').textContent = String(Math.round(Math.abs(car.v) * (air ? KMH : sea ? KNOTS : 2.2)));
    drawMap(mctx, mini.width, { car, others: NET.others.values(), air, sea, team: NET.team, mon: monMapPose() });
    airHud(air, sea);
    teamHud();                                                     // issue #24: the team bar, the capture meter, the round's banner
    monHud();                                                      // issue #26: Velemlok: the ship's countdown, the team bar's row, the result
  }
  drawReticle(G.state === 'drive'); drawShipHud(G.state === 'drive');
  updateImpactFx(dt);
  // the screen shake of a blast: the camera moves for this one picture only
  let shx = 0, shy = 0;
  if (fx.shakeT > 0) { fx.shakeT -= dt; const a = Math.max(0, fx.shakeT) * 2.5; shx = (Math.random() - 0.5) * a; shy = (Math.random() - 0.5) * a; }
  camera.position.x += shx; camera.position.y += shy; scene.render(); camera.position.x -= shx; camera.position.y -= shy;
  perfTick(raw);
  // World of DODO, issue #31: the first picture is there: the 3D view fades in over the night sky the page showed meanwhile
  // (client/index.html, html.city); a warm frame drawn: the loading screen's last step counts it
  if (!drawn) { drawn = true; document.documentElement.classList.add('city'); LOAD.t.render = performance.now(); }
  if (G.state === 'load' && --warmFrames <= 0) nudge();
}

// World of DODO, issue #14: what the HUD shows for a plane (height, throttle, parcels on board) and its hints in the toast line; the vehicle
// button names the next vehicle (V); while destroyed the next vehicle can be picked. Elements change only when their content does.
// World of DODO, issue #20: for a ship the speed in knots and its card (the telegraph, the rudder, the turrets and the torpedoes)
let hudAir: boolean | null = null, hudSea: boolean | null = null, hudK = -1;
function airHud(air: boolean, sea: boolean) {
  if (air !== hudAir) { hudAir = air; document.querySelectorAll<HTMLElement>('.gauge .air').forEach(e => { e.hidden = !air; }); }
  if (sea !== hudSea) { hudSea = sea; $('sea').hidden = !sea; $('spdU').textContent = sea ? T.knots : T.speedUnit; }
  if (car.next !== hudK) {
    hudK = car.next; $('vehLbl').textContent = vehName((car.next + 1) % 3);
    document.querySelectorAll<HTMLElement>('#pick button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === car.next));
  }
  const dead = car.topT > 0; if ($('pick').hidden === dead) $('pick').hidden = !dead;
  if (car.k === 0) { releaseMouse(); return; }                       // a tank: the hints come from updateDrive
  if (car.k === 2) {                                                // a ship
    seaHud();
    let msg = '';
    if (sh.t < 7) msg = COARSE ? T.hintShip : T.hintShipDesk;
    if (!COARSE && !mouseLocked() && !dead) msg = T.hintLockShip;
    if (now() < flashUntil) msg = flashMsg;
    toast(msg);
    return;
  }
  $('alt').textContent = String(Math.max(0, Math.round(car.y * M_PER_U))); $('thr').textContent = String(Math.round(pl.thr * 100)); $('bombs').textContent = String(pl.bombs);
  let msg = '';
  if (pl.t < 7) msg = COARSE ? T.hintPlane : T.hintPlaneDesk;
  if (!COARSE && !mouseLocked() && !dead) msg = T.hintLock;
  if (Math.max(Math.abs(car.x), Math.abs(car.z)) > AIR_LIM - 40 && !dead) msg = T.edge;
  if (now() < flashUntil) msg = flashMsg;
  toast(msg);
}

// ---------- World of DODO, issue #31: the boot, in slices behind the join form ----------
// What the boot and the starts measured (?test: WOD.boot; the report of issue #31): builds: how many times the city was built (once a
// page: a new start after Esc builds nothing); ms: each build call's own time (its slices added up, not the waits between them), the
// build's wall time, the fonts' wait after it, the pre-warm; spawnGap: at the last spawn, the distance to the nearest other vehicle
// (the spawn sees the others: it comes after the first snapshot); preWarmLate: the pre-warm ran out of time (PRE_WARM_MS); near: the
// cells of the houses' near detail (world/facade.ts NEAR: built, and built in a drawn frame); digest: the city as built (?test only:
// tools/browser-test.js compares two pages); steps: the last start's steps (and its pre-warm, its warm frames), ms from the Start
// click; psc: the browser compiles shaders in parallel
// unit: each build call's longest unit (ms: the longest stretch between two of its yields); warmLongest, warmAt: the longest single
// Mesh.isReady(true) of the pre-warm and the warm step (ms) and that mesh's name
const BOOT = {
  builds: 0, ms: {} as Record<string, number>, unit: {} as Record<string, number>, spawnGap: -1, preWarmLate: false, near: NEAR, digest: '',
  steps: {} as Record<string, number>, psc: false, warmLongest: 0, warmAt: '',
};
const ms1 = (t: number) => Math.round(t * 10) / 10;

// The build calls in the original's order (it is the city: every page registers the same trees and lamps in the same order, the server
// knows them by index; the parked cars come from the map's kerb spots with their own seed, client/shared/traffic.ts), each with its
// share of the build's time (ms on a GPU laptop, high quality; issue #31's measurements), which the line under Start follows. The
// world builders are generators that yield between their units (a house, a street, a tile's bake: world/*.ts); the other calls are
// short and run whole, the page gets its turn between them (core/slice.ts run).
const BUILD: [string, () => Work | void, number][] = [
  ['buildCity', buildCity, 280], ['buildTraffic', buildTraffic, 20], ['finishCity', finishCity, 40],
  ['buildNet', buildNet, 0],                                       // what the server shares (BODIES), once the traffic and the parked cars exist
  ['buildTank', buildTank, 7], ['buildPlane', buildPlane, 4], ['buildShip', buildShip, 4], ['buildShots', buildShots, 1], ['buildBullets', buildBullets, 5],
  ['buildShells', buildShells, 3], ['buildPeds', buildPeds, 13], ['buildFx', buildFx, 5],
  ['buildLand', buildLand, 660],                                   // the land around the city (planes, #14): its own random numbers, after everything
  ['buildWater', buildWater, 2],                                   // the river's effects (ships, #20)
  ['buildObjectives', buildObjectives, 29], ['buildTeamHud', buildTeamHud, 1],   // the zones and the supply depots, the team's HUD (teams, #24; no random numbers)
  ['buildMonster', buildMonster, 22],                              // Velemlok and its effects (issue #26; no random numbers of the city's)
  ['initInput', initInput, 1],
  // then the page as the original's boot left it, a unit each: the window's size, the quality level remembered in this browser, the
  // tank at the depot (the camera on the intro's orbit)
  ['resize', () => { addEventListener('resize', onResize); onResize(); }, 1], ['initQuality', initQuality, 1], ['reset', () => { reset(); introCam(); }, 8],
];
const BUILD_ALL = BUILD.reduce((a, b) => a + b[2], 0);
// one call of the build, timed; its builder's fractions mapped into the call's share of the whole (0..1)
function* call(name: string, f: () => Work | void, from: number, to: number): Work {
  let t = performance.now(), ms = 0, unit = 0;
  const w = f(); ms = unit = performance.now() - t;
  if (w) for (;;) {
    t = performance.now(); const r = w.next(), d = performance.now() - t; ms += d; if (d > unit) unit = d;
    if (r.done) break;
    yield typeof r.value === 'number' ? from + (to - from) * r.value : undefined;
  }
  BOOT.ms[name] = ms1(ms); BOOT.unit[name] = ms1(unit);
  yield to;
}
function* build(): Work {
  BOOT.builds++;
  let done = 0;
  for (const [name, f, share] of BUILD) { const from = done / BUILD_ALL; done += share; yield* call(name, f, from, done / BUILD_ALL); }
}

// the city's digest: the props (their index, kind and place) and the meshes (how many, their vertices), FNV-1a; two pages that built
// the same city have the same one (tools/browser-test.js), and so has the build before the slices (issue #31's report)
function digest(): string {
  let h = 0x811c9dc5 >>> 0;
  const add = (s: string) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } };
  for (const p of PROPS) add(p.i + ',' + p.kind + ',' + p.x.toFixed(2) + ',' + p.z.toFixed(2) + ';');
  let v = 0; for (const m of scene.meshes) v += m.getTotalVertices();
  add('m' + scene.meshes.length + 'v' + v);
  return h.toString(16).padStart(8, '0');
}

// The fonts the canvas textures use (the name tags, the signs), at most 2.5 s; asked for at once, so they come beside the build
function fontsIn(): Promise<unknown> {
  if (!document.fonts?.load) return Promise.resolve();
  return Promise.race([Promise.all([document.fonts.load('600 40px Poppins').catch(() => {}), document.fonts.load('600 40px "IBM Plex Mono"').catch(() => {})]), new Promise(r => setTimeout(r, 2500))]);
}

// The city's state: built (the build calls have run: the world can be reset and left), and the promise a start waits on (false: the
// build failed, the game cannot run here)
let built = false, cityOk: (ok: boolean) => void = () => {};
const CITY = new Promise<boolean>(r => { cityOk = r; });
let preWarmed = false, preWarmOk: () => void = () => {};
const PREWARM = new Promise<void>(r => { preWarmOk = r; });

// Builds the city in slices, then (the city step is done) watches the textures and makes the shaders ready, and only then starts the
// render loop. An error in the build means the game cannot run in this browser: the start button says so (ui/hud.ts noStart).
async function boot() {
  // automated tests (tools/browser-test.js) open the page with ?test and reach the game through this; nothing else uses it.
  // scene and engine stand where three's renderer was. free (issue #16): the test asks it whether a spot by a real wall is clear of
  // trees and lamps (only the page knows them). Issue #31: set before the build, so a test can watch it (boot: the numbers above).
  if (TEST) {
    window.WOD = { car, NET, get state() { return G.state; }, K, PERF, setQuality, scene, engine, WORLD, TRAFFIC, PARKED, BODIES, PEDS, worldAt, serverNow, moveTank,
      HELD, input, pl, view, switchVehicle, free, sh, naval: { WATER_Y, SHIP_SPAWNS, inWater },
      teams: { TM, friendly, zoneP, ZONES, DEPOTS, zoneAt },   // issue #24: the round as this page knows it, the shared rules' places
      mon: MON, monModel, monFxCount,                           // issue #26: Velemlok as this page knows it, its model, its spray
      boot: BOOT, slice: SLICE };                               // issue #31: the boot's and the slices' numbers
  }
  const fonts = fontsIn(), t0 = performance.now();
  BOOT.psc = !!engine.getCaps().parallelShaderCompile;
  try {
    await run(build(), f => LOAD.progress('city', CITY_CODE + (1 - CITY_CODE) * f * 0.99));
    BOOT.ms.build = ms1(performance.now() - t0);
    built = true; LOAD.t.build = performance.now();
    // (each step below in a task of its own: an await of what is done already goes on in the same task, which then grows long)
    await yieldNow();
    if (TEST) BOOT.digest = digest();
  } catch (e) {
    reportError(e); bootFailed(); return;
  }
  // the fonts (they have had the build's time to come), then the canvas textures drawn again with them (one a unit: each is drawn
  // and uploaded again)
  const tf = performance.now();
  await fonts; await yieldNow();
  await run((function* (): Work { for (const f of TEXREG) { f(); yield; } })());
  BOOT.ms.fonts = ms1(performance.now() - tf);
  await yieldNow();
  LOAD.done('city'); cityOk(true); nudge();
  await yieldNow();
  void texWatch();
  await preWarm();
  // the maps decoded meanwhile go in from now on, one a frame, beside the intro's frames (core/matlib.ts startUploads: not during the
  // build or the pre-warm, which keep the GPU process busy, and an upload then waits for it, a long task while the player types)
  startUploads();
  // The original asked for the next frame before anything else, so a frame that threw did not stop the game; Babylon's loop stops
  // when its callback throws. So the error is reported (the console, and before the start the start button's line) and the loop goes on.
  last = performance.now();
  engine.runRenderLoop(() => { try { frame(); } catch (e) { reportError(e); } });
}
// the build threw: no game in this browser (the start button says so and stays off), and a start that waited for it is over
function bootFailed() {
  RUN++; G.state = 'intro'; G.spawned = false; cityOk(false); nudge();
  noStart();
}

// The pre-warm: every mesh's shaders (and its shadow's) compiled before anything is drawn, while the player still fills in the form,
// so the game's first seconds do not stop for them. Mesh.isReady(true) makes what is missing (enabled or not; nothing is drawn);
// where the browser compiles in parallel (KHR_parallel_shader_compile) the compile goes on beside the page and a later pass finds it
// done. At most PRE_WARM_MS: after that the game compiles what is left as it draws it (as before issue #31).
const PRE_WARM_MS = 15000;
async function preWarm() {
  const t = performance.now();
  const ok = await ready(t + PRE_WARM_MS, 0, f => LOAD.progress('warm', 0.7 * f));
  BOOT.preWarmLate = !ok; BOOT.ms.preWarm = ms1(performance.now() - t); LOAD.t.preWarm = performance.now();
  preWarmed = true; preWarmOk(); nudge();
}
// passes over the scene's meshes in slices until all are ready (true) or the time is up (false); a start that is over ends it too
// (me: that start; 0 for the pre-warm, which nothing ends). onFrac hears the share ready after each pass.
async function ready(until: number, me: number, onFrac: (f: number) => void): Promise<boolean> {
  for (;;) {
    const list = scene.meshes.slice();
    let n = 0, slice = performance.now();
    for (const m of list) {
      const t = performance.now();
      if (m.isDisposed() || m.isReady(true)) n++;
      const e = performance.now();
      if (e - t > BOOT.warmLongest) { BOOT.warmLongest = ms1(e - t); BOOT.warmAt = m.name; }
      if (e - slice >= SLICE_MS) { await yieldNow(); slice = performance.now(); }
    }
    onFrac(list.length ? n / list.length : 1);
    if (n === list.length) return true;
    if (performance.now() > until || (me && me !== RUN)) return false;
    await sleep(16);                                                // (the compiles go on meanwhile)
  }
}

// The textures (core/matlib.ts and the roofs' maps): done when every map the materials want has been asked for and the scene waits for
// none (Babylon counts a texture until it has loaded or failed). Watched from the city's end on, also before any Start, so a Start
// after they came waits for the network only. A start's time limit may have marked the step done late meanwhile; the textures that
// come later mark it done for real (ui/loading.ts done).
// World of DODO, issue #31: a Start watches them again when maps were asked for again since they came (texAgain); one watch at a time
// (the guard is a cheap safety: texAgain starts none while one runs).
let texWatching = false;
const texIn = () => matIssued() && scene.getWaitingItemsCount() === 0;
// World of DODO, issue #31: does a Start now have to wait for the textures again (startRun)? Maps on their way although their step was
// done: Q in the menu, or the automatic quality drop in the game before an Esc, asked for another level's maps. Not while the first
// watch still runs: then the step was marked done late by a start's time limit (a slow connection) and the maps never came, and a new
// start goes in at once with the step still late, as before (it waited the whole TEX_MS again at every Esc and Start). Only once the
// city is done: before that boot() starts the one watch. ui/join.ts asks the same (JOIN_HOOK.texAgain) before it locks the pointer.
const texAgainNow = () => LOAD.isDone('city') && !texWatching && !texIn();
async function texWatch() {
  if (texWatching) return;
  texWatching = true;
  let peak = 0;
  for (;;) {
    const w = scene.getWaitingItemsCount(); if (w > peak) peak = w;
    if (matIssued() && w === 0) {
      texWatching = false;
      LOAD.done('tex'); if (G.state === 'load') BOOT.steps.tex = Math.round(performance.now() - (LOAD.t.open ?? 0)); nudge(); return;
    }
    if (matIssued() && peak) LOAD.progress('tex', 1 - w / peak);
    await sleep(100);
  }
}

// ---------- World of DODO, issue #31: from Start into the game ----------
// The time limits (ms; ?test may change them, window.WOD_OVR): the textures from the later of Start and the city's end (then the game
// begins without them: they finish in the game); the connection from the socket's creation to welcome, the first snapshot after
// welcome (then back to the form: T.errConn); the shaders round the spawn (then the game begins, the rest compiles as it is drawn).
const TEX_MS = 8000, CONNECT_MS = 10000, SNAP_MS = 5000, WARM_MS = 8000;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// Waiting for a step: until(ok) wakes on nudge() (welcome, the first snapshot, a step done, a cancel) and checks at least every 250 ms.
// true: ok; false: the time is up, or this start is over (RUN changed: the caller just returns then).
const WAKE = new Set<() => void>();
function nudge() { const w = [...WAKE]; WAKE.clear(); for (const f of w) f(); }
async function until(ok: () => boolean, ms: number, me: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (me === RUN && !ok()) {
    const left = end - performance.now(); if (left <= 0) return false;
    await new Promise<void>(r => { const f = () => { clearTimeout(t); WAKE.delete(f); r(); }, t = setTimeout(f, Math.min(left, 250)); WAKE.add(f); });
  }
  return me === RUN;
}

// The start in progress: each Start (and each way back) moves RUN on, and a start that finds RUN moved after an await is over.
let RUN = 0;
async function startRun(j: Join) {
  const me = ++RUN, alive = () => me === RUN, t0 = LOAD.t.open ?? performance.now(), ovr = TEST ? window.WOD_OVR ?? {} : {};
  const at = (id: string) => { BOOT.steps[id] = Math.round(performance.now() - t0); };
  G.state = 'load'; G.spawned = false; BOOT.steps = {};
  // World of DODO, issue #31: the textures again if maps are on their way since their step was done (texAgainNow): undone before the
  // step list of this start is taken (LOAD.last.pre), watched again, and their time limit below counts from this Start; without it the
  // start went in on the stand-ins and the maps uploaded in the game's first seconds. A step done late whose watch still runs stays
  // as it is: the start goes in on the network only.
  const texAgain = texAgainNow();
  LOAD.begin(texAgain);
  if (texAgain) void texWatch();
  if (preWarmed) LOAD.progress('warm', 0.7);                       // (a start after the pre-warm: its share of the last step is there)
  // 1. the city: the code and the build, usually done behind the form already
  if (!await CITY || !alive()) return;
  startUploads();                                                  // (if the pre-warm has not let them go yet: behind the screen now)
  at('city');
  // 2. the textures, beside the network: their time limit from now on (the later of Start and the city's end)
  if (!LOAD.isDone('tex')) setTimeout(() => { if (alive() && !LOAD.isDone('tex')) { LOAD.done('tex', true); nudge(); } }, ovr.texMs ?? TEX_MS);
  // 3. the connection (after the city: a snapshot needs BODIES). The server counts the player from hello on, but keeps it out of the
  // snapshots until its first st, which this page sends only in the game (docs/PROTOCOL.md, Limits).
  NET.name = j.name; NET.color = j.color; NET.teamPick = j.team; NET.want = true; NET.err = '';
  netConnect();
  if (!alive()) return;                                           // (the socket could not even be made: abortRun has run)
  if (!await until(() => LOAD.isDone('net'), ovr.connectMs ?? CONNECT_MS, me)) { if (alive()) abortRun(T.errConn, 'screen'); return; }
  at('net');
  // 4. the game's first state: the first snapshot after welcome says where the others and the cars are, so the spawn can avoid them
  if (!await until(() => NET.snaps > 0, ovr.snapMs ?? SNAP_MS, me)) { if (alive()) abortRun(T.errConn, 'screen'); return; }
  spawn(j);
  LOAD.done('snap'); at('snap');
  // 5. the shaders: the pre-warm (its 70 %: usually done behind the form), then what the spawn brought near (30 %)
  await PREWARM; if (!alive()) return;
  LOAD.progress('warm', 0.7); at('preWarm');
  // World of DODO, issue #31: once more when a respawn (a new round, a team move: game/teams.ts, net/net.ts) moved the camera after
  // warmAround, while the frames or the textures were awaited: the cells round the new place, or the game's first frame builds them
  // all at once (world/facade.ts bakeCells). Not after a late pass: then the game builds the rest anyway. (The bar never goes back.)
  let late = false;
  do {
    late = !await warmAround(me, performance.now() + WARM_MS) || late; if (!alive()) return;
    warmMap();
    // a hidden tab draws no frames: the last ones wait until it is shown
    if (document.hidden && !await until(() => !document.hidden, 1e9, me)) return;
    warmFrames = 3;                                                // three frames drawn behind the screen: what is left compiles there
    if (!await until(() => warmFrames <= 0, 1e9, me)) return;
    at('frames');
    // the textures, if they have neither come nor run out of time yet
    if (!await until(() => LOAD.isDone('tex'), 1e9, me)) return;
  } while (!late && nearAround(camera.position.x, camera.position.y, camera.position.z, 0) > 0);
  LOAD.done('warm', late); at('warm');
  enterGame();
}

// welcome (net/net.ts, the first one of a start): a fresh start of this page's world as the server sees it (the depot, the traffic and
// the props as new, as the original's start did), no spawn yet. The step is done.
export function onWelcome() { reset(); LOAD.done('net'); nudge(); }
// the first snapshot after welcome (net/net.ts): startRun goes on
export function onFirstSnap() { nudge(); }

// The vehicle the player chose, where the city lets it: the others first where the snapshot says they are (on, the planes and ships
// made), the cars in their places, so spawnPoint keeps clear of them; the camera behind it as the game's first frame has it
// (respawn: camBehind, or planeCam / shipCam at once).
function spawn(j: Join) {
  const t = performance.now();
  netUpdate(0, t); worldUpdate(0, t);
  car.next = j.veh; respawn(true); G.spawned = true;
  let gap = Infinity;
  for (const o of NET.others.values()) if (o.on) gap = Math.min(gap, Math.hypot(o.x - car.x, o.z - car.z));
  BOOT.spawnGap = Math.round(gap * 10) / 10;
}

// After the spawn: the houses' near detail round the camera (world/facade.ts builds it a cell at a time as the camera comes near; here
// two cells a slice, so the first frames build none), then the shaders of what is new (those cells, the others' planes and ships). A
// respawn meanwhile (a new round, a team move: game/teams.ts) moves the camera: the cells round the new place are built too. false: the
// time ran out (WARM_MS); the game then builds and compiles the rest as it draws it.
async function warmAround(me: number, until: number): Promise<boolean> {
  const p = camera.position, all = Math.max(1, nearAround(p.x, p.y, p.z, 0));
  for (;;) {
    let left = nearAround(p.x, p.y, p.z, 0);
    while (left > 0) {
      left = nearAround(p.x, p.y, p.z, 2);
      LOAD.progress('warm', 0.7 + 0.15 * (1 - left / all));
      if (performance.now() > until) return false;
      await yieldNow(); if (me !== RUN) return false;
    }
    if (!await ready(until, me, f => LOAD.progress('warm', 0.85 + 0.15 * f))) return false;
    if (!nearAround(p.x, p.y, p.z, 0)) return true;               // (no respawn moved it meanwhile)
  }
}

// The minimap's picture of the city (ui/minimap.ts draws it once for the canvas's size and the view, a few tens of ms) drawn now,
// behind the screen, and not in the game's first frame. The HUD is laid out for it unseen (visibility), so the canvas has the size it
// will have in the game.
function warmMap() {
  const hud = $('hud'); hud.style.visibility = 'hidden'; hud.hidden = false;
  $('mini').classList.remove('big');                               // the game starts with the small map (enterGame): size and draw it as such
  sizeMini();
  drawMap(mctx, mini.width, { car, others: NET.others.values(), air: car.k === 1, sea: car.k === 2, team: NET.team, mon: monMapPose() });
  hud.hidden = true; hud.style.visibility = '';
}

// into the game: the HUD, the touch controls; the frame clock and the performance readout start now (the time behind the loading
// screen does not count), the screen fades out
function enterGame() {
  G.state = 'drive'; G.spawned = false;
  $('mini').classList.remove('big'); $('hud').hidden = false; $('touch').hidden = !COARSE;
  sizeMini(); last = performance.now(); perfReset();
  LOAD.enter();
}

// The one way back to the form: Cancel or Esc while loading (ui/loading.ts), Esc or the menu button in the game (backToMenu, issue
// #22), a failure (no server, a time limit, the server's refusal: net/net.ts netFail). The start in progress is over (RUN), the
// socket closed (the server drops the player as for a closed tab), the city back to the browser's own as before the first start.
// The build behind the form is not touched: a new start waits only for the network. msg: say why (how: ui/loading.ts fail).
export function abortRun(msg?: string, how: FailHow = 'screen') {
  RUN++; nudge(); warmFrames = 0;
  // World of DODO, issue #31: a Start lets the maps upload as soon as the city is built (startRun), beside the pre-warm, because the
  // loading screen covers the page. A start over before the pre-warm's end brings the form back, where the player types while the
  // pre-warm still runs: the uploads wait again (core/matlib.ts stopUploads; boot lets them go at the pre-warm's end, a new Start
  // at once)
  if (!preWarmed) stopUploads();
  if (document.pointerLockElement) document.exitPointerLock();
  for (const k in K) K[k as keyof typeof K] = false;
  HELD.clear(); input.lmb = input.rmb = false; input.steerAxis = input.pitchAxis = 0;
  if (built) {                                                     // (before the build nothing is connected and nothing to reset)
    netLeave(); reset(); introCam();
    NET.team = -1; teamsWelcome(undefined); for (const g of [view.van, view.plane, view.ship]) flagTeam(g, -1);   // issue #24: no team in the menu
  }
  NET.want = false;
  G.state = 'intro'; G.spawned = false;
  $('hud').hidden = true; $('touch').hidden = true; $('pick').hidden = true; $('roundEnd').hidden = true; monHudOff();
  if (msg) LOAD.fail(msg, how); else LOAD.close();
}
// World of DODO, issue #22: Esc (or the menu button) leaves the game for the start screen and its choices; the tab stays open. The city
// goes back to the browser's own, as before the first start, and the start button joins again (issue #31: abortRun).
export function backToMenu() {
  if (G.state !== 'drive') return;
  abortRun();
}

// ---------- the start ----------
// World of DODO, issue #31: the join form (ui/join.ts) lives in the page's first script; what the 3D needs from it is the own tank's
// paint, now and as the colour changes. A Start clicked before this module was there waits in LOAD.pending: it goes on now.
JOIN_HOOK.paint = c => { paintMat(vanOwnMat, c); };
JOIN_HOOK.texAgain = texAgainNow;
paintMat(vanOwnMat, JOIN.color);
document.addEventListener('visibilitychange', () => { paused = document.hidden; last = performance.now(); nudge(); });
LOAD.on.start = j => { void startRun(j); };
LOAD.on.cancel = () => abortRun();
if (LOAD.pending) { const p = LOAD.pending; LOAD.pending = null; void startRun(p.join); }
void boot();
