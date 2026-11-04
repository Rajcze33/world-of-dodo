// Input: the keyboard, the mouse (a plane's aim and guns), the touch steering pad and buttons, the camera and vehicle buttons, the
// minimap click. Everything lands in K (keys held), HELD (the keys held by code), and input (game/state.ts); updateDrive (game/tank.ts)
// and updateFly (game/plane.ts) read them.
import { $, COARSE } from '../core/dom';
import { canvas } from '../core/engine';
import { G, K, HELD, car, input } from './state';
import { sizeMini } from '../ui/minimap';
import { switchVehicle } from './tank';

type Key = keyof typeof K;
// Space = fire parcels (was brake; Down/S still brakes and reverses); E = the second weapon (World of DODO, issue #14)
const KEYMAP: Record<string, Key> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'fire',
};
const flying = () => G.state === 'drive' && car.k === 1;
const locked = () => document.pointerLockElement === canvas;

// main.ts calls this once at boot
export function initInput() {
  addEventListener('keydown', e => {
    if (G.state !== 'drive' || e.target instanceof HTMLInputElement) return;
    const k = KEYMAP[e.code];
    if (k) { K[k] = true; e.preventDefault(); }
    HELD.add(e.code);
    if (e.code === 'KeyC') G.camMode ^= 1;
    // World of DODO, issue #14: V switches vehicles; 1 and 2 pick the next one (while destroyed, the pick shows)
    if (e.repeat) return;
    if (e.code === 'KeyV') switchVehicle();
    else if (e.code === 'Digit1' || e.code === 'Digit2') switchVehicle(e.code === 'Digit1' ? 0 : 1);
  });
  addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) K[k] = false; HELD.delete(e.code); });
  addEventListener('blur', () => { for (const k in K) K[k as Key] = false; HELD.clear(); input.steerAxis = input.pitchAxis = 0; input.lmb = input.rmb = false; });

  // World of DODO, issue #14: a plane follows the mouse. A click into the game locks the mouse to it (Esc lets go, the browser's rule);
  // while locked its movement turns the aim, the left button fires the guns, the right one drops a parcel (a tank: its anti-aircraft gun)
  canvas.addEventListener('mousedown', e => {
    if (G.state !== 'drive') return;
    if (flying() && !COARSE && !locked()) lockMouse();
    if (e.button === 0) input.lmb = true; else if (e.button === 2) input.rmb = true;
  });
  addEventListener('mouseup', e => { if (e.button === 0) input.lmb = false; else if (e.button === 2) input.rmb = false; });
  addEventListener('mousemove', e => { if (locked() && flying()) { input.mx += e.movementX; input.my += e.movementY; } });
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
  document.querySelectorAll<HTMLElement>('#pick button').forEach(b => b.addEventListener('click', () => switchVehicle(b.dataset.v === '1' ? 1 : 0)));
  $('mini').addEventListener('click', () => { $('mini').classList.toggle('big'); sizeMini(); });
}
// lock the mouse to the game (from a click or the start button: the browser allows it only in answer to the user)
export function lockMouse() {
  try { const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined; p?.catch?.(() => { /* refused: the hint stays */ }); } catch (_) { /* not allowed now */ }
}
// a tank does not need the mouse locked (main.ts lets it go after a switch to the tank)
export function releaseMouse() { if (locked() && !flying()) document.exitPointerLock(); }
export const mouseLocked = locked;
