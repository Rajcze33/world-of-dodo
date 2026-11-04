// Input: the keyboard, the mouse (a plane's aim and guns, a ship's camera and guns), the touch steering pad and buttons, the camera and
// vehicle buttons, the minimap click. Everything lands in K (keys held), HELD (the keys held by code), and input (game/state.ts);
// updateDrive (game/tank.ts), updateFly (game/plane.ts) and updateShip (game/ship.ts) read them.
import { $, COARSE } from '../core/dom';
import { canvas } from '../core/engine';
import { G, K, HELD, car, input } from './state';
import { sizeMini } from '../ui/minimap';
import { switchVehicle } from './tank';
import { backToMenu } from '../main';

type Key = keyof typeof K;
// Space = fire parcels (was brake; Down/S still brakes and reverses); E = the second weapon (World of DODO, issue #14)
const KEYMAP: Record<string, Key> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'fire',
};
const flying = () => G.state === 'drive' && car.k === 1;
// World of DODO, issue #20: the mouse aims a plane or a ship (the ship's camera orbits it)
const aiming = () => G.state === 'drive' && car.k !== 0;
const locked = () => document.pointerLockElement === canvas;
let unlockedAt = 0;                                            // when the mouse was last let go (issue #22: that Esc was the browser's)

// main.ts calls this once at boot
export function initInput() {
  addEventListener('keydown', e => {
    if (G.state !== 'drive' || e.target instanceof HTMLInputElement) return;
    // World of DODO, issue #22: Esc goes back to the menu. With the mouse locked (a plane, a ship) the browser takes the first Esc to let
    // the mouse go: that one only unlocks (if it reaches the page at all), the next one leaves.
    if (e.code === 'Escape') { if (!locked() && performance.now() - unlockedAt > 300) backToMenu(); return; }
    const k = KEYMAP[e.code];
    if (k) { K[k] = true; e.preventDefault(); }
    HELD.add(e.code);
    if (e.code === 'KeyC') G.camMode ^= 1;
    // World of DODO, issue #14: V switches vehicles; 1 and 2 pick the next one (while destroyed, the pick shows); issue #20: 3 the ship
    if (e.repeat) return;
    if (e.code === 'KeyV') switchVehicle();
    else if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') switchVehicle(e.code === 'Digit1' ? 0 : e.code === 'Digit2' ? 1 : 2);
  });
  addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) K[k] = false; HELD.delete(e.code); });
  addEventListener('blur', () => { for (const k in K) K[k as Key] = false; HELD.clear(); input.steerAxis = input.pitchAxis = 0; input.lmb = input.rmb = false; });

  // World of DODO, issue #14: a plane follows the mouse. A click into the game locks the mouse to it (Esc lets go, the browser's rule);
  // while locked its movement turns the aim, the left button fires the guns, the right one drops a parcel (a tank: its anti-aircraft gun)
  // World of DODO, issue #20: a ship's camera follows the mouse the same way; the left button fires its turrets, the right one looks
  // through the binoculars. The click that locks the mouse does not fire a ship's guns (a salvo is too much for a click into the game).
  canvas.addEventListener('mousedown', e => {
    if (G.state !== 'drive') return;
    if (aiming() && !COARSE && !locked()) { lockMouse(); if (car.k === 2) return; }
    if (e.button === 0) input.lmb = true; else if (e.button === 2) input.rmb = true;
  });
  addEventListener('mouseup', e => { if (e.button === 0) input.lmb = false; else if (e.button === 2) input.rmb = false; });
  addEventListener('mousemove', e => { if (locked() && aiming()) { input.mx += e.movementX; input.my += e.movementY; } });
  // World of DODO, issue #20: on a touch screen a ship's camera turns with a finger dragged over the game (not on a button or the pad)
  {
    let tid = -1, tx = 0, ty = 0;
    canvas.addEventListener('pointerdown', e => { if (e.pointerType === 'touch' && G.state === 'drive' && car.k === 2 && tid < 0) { tid = e.pointerId; tx = e.clientX; ty = e.clientY; } });
    canvas.addEventListener('pointermove', e => { if (e.pointerId !== tid) return; input.mx += (e.clientX - tx) * 1.6; input.my += (e.clientY - ty) * 1.6; tx = e.clientX; ty = e.clientY; });
    for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, e => { if ((e as PointerEvent).pointerId === tid) tid = -1; });
  }
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('pointerlockchange', () => { if (!locked()) input.lmb = input.rmb = false; });

  // the steering pad: the knob follows the finger, -1 (left edge) .. 1 (right edge); in a plane also up and down (pitchAxis)
  {
    const pad = $('steer'), knob = $('knob');
    const set = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect(), half = r.width / 2 - 32;
      input.steerAxis = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / half));
      input.pitchAxis = flying() ? Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 60)) : 0;
      knob.style.transform = 'translate(' + (input.steerAxis * half) + 'px,' + (input.pitchAxis * 20) + 'px)';
    };
    const rel = () => { pad.classList.remove('on'); input.steerAxis = input.pitchAxis = 0; knob.style.transform = ''; };
    pad.addEventListener('pointerdown', e => { e.preventDefault(); pad.classList.add('on'); try { pad.setPointerCapture(e.pointerId); } catch (_) { /* the pointer is gone already */ } set(e); });
    pad.addEventListener('pointermove', e => { if (pad.classList.contains('on')) set(e); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(ev, rel);
    pad.addEventListener('contextmenu', e => e.preventDefault());
  }
  // the touch buttons: brake, gas, fire, the second weapon (data-k: the key they hold)
  document.querySelectorAll<HTMLElement>('.tbtn').forEach(b => {
    const k = b.dataset.k as Key;
    const on = (e: PointerEvent) => { e.preventDefault(); K[k] = true; b.classList.add('on'); try { b.setPointerCapture(e.pointerId); } catch (_) { /* the pointer is gone already */ } };
    const off = () => { K[k] = false; b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
    b.addEventListener('contextmenu', e => e.preventDefault());
  });
  $('camBtn').addEventListener('click', () => { G.camMode ^= 1; });
  $('vehBtn').addEventListener('click', () => switchVehicle());
  $('menuBtn').addEventListener('click', () => backToMenu());                   // issue #22 (a phone has no Esc)
  document.addEventListener('pointerlockchange', () => { if (!locked()) unlockedAt = performance.now(); });
  document.querySelectorAll<HTMLElement>('#pick button').forEach(b => b.addEventListener('click', () => switchVehicle(b.dataset.v === '2' ? 2 : b.dataset.v === '1' ? 1 : 0)));
  $('mini').addEventListener('click', () => { $('mini').classList.toggle('big'); sizeMini(); });
}
// lock the mouse to the game (from a click or the start button: the browser allows it only in answer to the user)
export function lockMouse() {
  try { const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined; p?.catch?.(() => { /* refused: the hint stays */ }); } catch (_) { /* not allowed now */ }
}
// a tank does not need the mouse locked (main.ts lets it go after a switch to the tank)
export function releaseMouse() { if (locked() && !aiming()) document.exitPointerLock(); }
export const mouseLocked = locked;
