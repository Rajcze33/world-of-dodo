// World of DODO in the browser: the boot, the join form, and the frame loop (the order of the updates, the camera, the light).
//
// ui/hud.ts comes first on purpose: it puts the texts into the page and arms the start button's "cannot start" line before
// core/engine.ts creates the 3D engine, which throws when the browser has no WebGL (see ui/hud.ts).
import { noStart } from './ui/hud';
import type { Vector3, TransformNode } from '@babylonjs/core';
import { engine, scene, camera, lookAt, moonAt, resize, aspect, setFog } from './core/engine';
import { TEXREG } from './core/tex';
import { $, COARSE } from './core/dom';
import { hexCss } from './core/util';
import { T } from './texts';
import { G, car, K, HELD, input, view } from './game/state';
import { groundH, segHit, free, AIR_LIM, DATA } from './world/grid';
import { drawMap, sizeMini, mini, mctx } from './ui/minimap';
import { initInput, lockMouse, releaseMouse, mouseLocked } from './game/input';
import { PERF, setQuality, initQuality, perfTick } from './game/quality';
import { buildCity, finishCity, CRANE_TOP } from './world/city';
import { updateProps } from './world/props';
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
import { NET, netUpdate, netConnect, netLeave, cleanName, botName, joinErr, TANK_COLORS, serverNow } from './net/net';
import { toast, flashMsg, flashUntil } from './ui/hud';
import { now } from './core/util';
import { WORLD, worldUpdate, worldAt, BODIES, buildNet } from './net/world';

// ---------- loop ----------
// camLook (game/tank.ts): the point the camera looks at, eased like the camera itself; reset and respawn put it on the tank
let last = performance.now(), orbit = 0, paused = false;
// World of DODO, issue #16: the intro circles Karlínské náměstí with the church of sv. Cyril a Metoděj (the map's landmark), the middle
// of the real Karlín as people know it; the old invented city was simply centred on 0, 0
const INTRO = DATA.landmarks.church || { x: 0, z: 0 };
// three's v.lerp(target, a), without a new vector every frame
function lerpTo(v: Vector3, x: number, y: number, z: number, a: number) { v.x += (x - v.x) * a; v.y += (y - v.y) * a; v.z += (z - v.z) * a; }
// the window's size: the 3D view (and its lens, wider on a portrait screen) and the minimap's canvas
function onResize() { resize(); sizeMini(); }

function frame() {
  if (paused) return;
  const tnow = performance.now(), raw = tnow - last, dt = Math.min(0.05, raw / 1000); last = tnow;
  // World of DODO: a tank, a plane (#14) or a ship (#20)
  if (G.state === 'drive') { if (car.k === 1) updateFly(dt); else if (car.k === 2) updateShip(dt); else updateDrive(dt); G.realSec += dt; }
  if (WORLD.on) worldUpdate(dt, tnow); else { updateTraffic(dt); updatePeds(dt); }   // World of DODO: once you play, the city comes from the server
  updateShots(dt); updateBullets(dt); updateShells(dt); updateProps(dt);
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
  if (G.state === 'drive') {
    $('spd').textContent = String(Math.round(Math.abs(car.v) * (air ? KMH : sea ? KNOTS : 2.2)));
    drawMap(mctx, mini.width, { car, others: NET.others.values(), air, sea });
    airHud(air, sea);
  }
  drawReticle(G.state === 'drive'); drawShipHud(G.state === 'drive');
  updateImpactFx(dt);
  // the screen shake of a blast: the camera moves for this one picture only
  let shx = 0, shy = 0;
  if (fx.shakeT > 0) { fx.shakeT -= dt; const a = Math.max(0, fx.shakeT) * 2.5; shx = (Math.random() - 0.5) * a; shy = (Math.random() - 0.5) * a; }
  camera.position.x += shx; camera.position.y += shy; scene.render(); camera.position.x -= shx; camera.position.y -= shy;
  perfTick(raw);
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

// World of DODO: the server said welcome (net/net.ts calls this), drive out from a free spot on the streets, or fly in (the original went
// intro → plan → drive)
let joinVeh: 0 | 1 | 2 = 0;
export function start() {
  reset(); car.next = joinVeh; respawn(true);
  G.state = 'drive'; nameIn.blur(); $('intro').hidden = true; $('mini').classList.remove('big'); $('hud').hidden = false; $('touch').hidden = !COARSE;
  sizeMini(); last = performance.now();
}
// World of DODO, issue #22: Esc (or the menu button) leaves the game for the start screen and its choices; the tab stays open. The city
// goes back to the browser's own, as before the first start, and the start button joins again.
export function backToMenu() {
  if (G.state !== 'drive') return;
  if (document.pointerLockElement) document.exitPointerLock();
  for (const k in K) K[k as keyof typeof K] = false;
  HELD.clear(); input.lmb = input.rmb = false; input.steerAxis = input.pitchAxis = 0;
  netLeave(); reset();
  G.state = 'intro'; $('intro').hidden = false; $('hud').hidden = true; $('touch').hidden = true; $('pick').hidden = true;
  $<HTMLButtonElement>('startBtn').disabled = false; $('startLbl').textContent = T.start; joinErr('');
  if (!COARSE) nameIn.focus();
}

// the join form: a name and a tank colour, both remembered in this browser for the next time, nothing else
const nameIn = $<HTMLInputElement>('nameIn');
function joinForm() {
  let savedColor = NaN;
  try { nameIn.value = localStorage.getItem('wod-name') || ''; savedColor = parseInt(localStorage.getItem('wod-color') ?? '', 16); } catch (_) { /* storage blocked */ }
  NET.color = TANK_COLORS.includes(savedColor) ? savedColor : TANK_COLORS[Math.random() * TANK_COLORS.length | 0];
  $('swatches').innerHTML = TANK_COLORS.map((c, i) => '<label class="sw"><input type="radio" name="color" value="' + i + '"' + (c === NET.color ? ' checked' : '') + '><span style="background:' + hexCss(c) + '"></span></label>').join('');
  document.querySelectorAll<HTMLInputElement>('#swatches input').forEach(r => {
    r.setAttribute('aria-label', T.colorNames[Number(r.value)]);
    r.addEventListener('change', () => { NET.color = TANK_COLORS[Number(r.value)]; paintMat(vanOwnMat, NET.color); });
  });
  paintMat(vanOwnMat, NET.color);
  // World of DODO, issue #14: the vehicle, a tank or a plane (issue #20: or a ship), remembered too
  const veh = (v: string | null) => (v === '1' ? 1 : v === '2' ? 2 : 0) as 0 | 1 | 2;
  try { joinVeh = veh(localStorage.getItem('wod-veh')); } catch (_) { /* storage blocked */ }
  document.querySelectorAll<HTMLInputElement>('input[name=veh]').forEach(r => {
    r.checked = Number(r.value) === joinVeh;
    r.addEventListener('change', () => { joinVeh = veh(r.value); });
  });
  $('joinForm').addEventListener('submit', e => {
    e.preventDefault(); const b = $<HTMLButtonElement>('startBtn'); if (b.disabled) return;
    const name = cleanName(nameIn.value); if (!name || botName(name)) { joinErr(name ? T.errReserved : T.errName); nameIn.focus(); return; }
    try { localStorage.setItem('wod-name', name); localStorage.setItem('wod-color', NET.color.toString(16)); localStorage.setItem('wod-veh', String(joinVeh)); } catch (_) { /* storage blocked: not remembered */ }
    if (joinVeh !== 0 && !COARSE) lockMouse();                       // a plane (a ship) aims with the mouse: lock it now, while the browser allows it (a click)
    joinErr(''); b.disabled = true; $('startLbl').textContent = T.connecting; NET.name = name; NET.want = true; NET.err = ''; netConnect();
  });
}

// Build the city and everything in it (in the original's order), then start the loop on the intro's orbit. An error here means the
// game cannot run in this browser: the start button says so instead of loading forever.
function boot(): boolean {
  try {
    // the city is built from the map data in a fixed order, so every client registers the same trees and lamps (the server knows
    // them by index); the parked cars come from the map's kerb spots with their own seed (client/shared/traffic.ts)
    // buildNet: what the server shares (BODIES), filled once the traffic and the parked cars exist, before anyone can join
    buildCity(); buildTraffic(); finishCity(); buildNet(); buildTank(); buildPlane(); buildShip(); buildShots(); buildBullets(); buildShells(); buildPeds(); buildFx();
    buildLand();                                                   // the land around the city (planes, #14): its own random numbers, after everything
    buildWater();                                                  // the river's effects (ships, #20)
    initInput();
    joinForm();
    // automated tests (tools/browser-test.js) open the page with ?test and reach the game through this; nothing else uses it.
    // scene and engine stand where three's renderer was. free (issue #16): the test asks it whether a spot by a real wall is clear of
    // trees and lamps (only the page knows them).
    if (new URLSearchParams(location.search).has('test')) {
      window.WOD = { car, NET, get state() { return G.state; }, K, PERF, setQuality, scene, engine, WORLD, TRAFFIC, PARKED, BODIES, PEDS, worldAt, serverNow, moveTank,
        HELD, input, pl, view, switchVehicle, free, sh, naval: { WATER_Y, SHIP_SPAWNS, inWater } };
    }
    addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', () => { paused = document.hidden; last = performance.now(); });
    onResize(); initQuality(); reset();
    // The original asked for the next frame before anything else, so a frame that threw did not stop the game; Babylon's loop stops
    // when its callback throws. So the error is reported (the console, and before the start the start button's line) and the loop goes on.
    engine.runRenderLoop(() => { try { frame(); } catch (e) { reportError(e); } });
    return true;
  } catch (e) {
    reportError(e); noStart();
    return false;
  }
}

const ready = () => { $<HTMLButtonElement>('startBtn').disabled = false; $('startLbl').textContent = T.start; if (!COARSE) nameIn.focus(); };
if (boot()) {
  (document.fonts && document.fonts.load
    ? Promise.race([Promise.all([document.fonts.load('600 40px Poppins').catch(() => {}), document.fonts.load('600 40px "IBM Plex Mono"').catch(() => {})]), new Promise(r => setTimeout(r, 2500))])
    : Promise.resolve()
  ).then(() => {
    TEXREG.forEach(f => f());                                      // redraw canvas textures once fonts are in
    ready();
  }).catch(e => { reportError(e); noStart(); });
}
