// Input: the keyboard, the touch steering pad and buttons, the camera button, the minimap click. Everything lands in K (keys held)
// and input.steerAxis (game/state.ts); updateDrive (game/tank.ts) reads them.
import { $ } from '../core/dom';
import { G, K, input } from './state';
import { sizeMini } from '../ui/minimap';

type Key = keyof typeof K;
// Space = fire parcels (was brake; Down/S still brakes and reverses)
const KEYMAP: Record<string, Key> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'fire',
};

// main.ts calls this once at boot
export function initInput() {
  addEventListener('keydown', e => {
    const k = KEYMAP[e.code];
    if (k && G.state === 'drive') { K[k] = true; e.preventDefault(); }
    if (e.code === 'KeyC' && G.state === 'drive') G.camMode ^= 1;
  });
  addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) K[k] = false; });
  addEventListener('blur', () => { for (const k in K) K[k as Key] = false; input.steerAxis = 0; });

  // the steering pad: the knob follows the finger, -1 (left edge) .. 1 (right edge)
  {
    const pad = $('steer'), knob = $('knob');
    const set = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect(), half = r.width / 2 - 32;
      input.steerAxis = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / half)); knob.style.transform = 'translateX(' + (input.steerAxis * half) + 'px)';
    };
    const rel = () => { pad.classList.remove('on'); input.steerAxis = 0; knob.style.transform = ''; };
    pad.addEventListener('pointerdown', e => { e.preventDefault(); pad.classList.add('on'); try { pad.setPointerCapture(e.pointerId); } catch (_) { /* the pointer is gone already */ } set(e); });
    pad.addEventListener('pointermove', e => { if (pad.classList.contains('on')) set(e); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(ev, rel);
    pad.addEventListener('contextmenu', e => e.preventDefault());
  }
  // the touch buttons: brake, gas, fire (data-k: the key they hold)
  document.querySelectorAll<HTMLElement>('.tbtn').forEach(b => {
    const k = b.dataset.k as Key;
    const on = (e: PointerEvent) => { e.preventDefault(); K[k] = true; b.classList.add('on'); try { b.setPointerCapture(e.pointerId); } catch (_) { /* the pointer is gone already */ } };
    const off = () => { K[k] = false; b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
    b.addEventListener('contextmenu', e => e.preventDefault());
  });
  $('camBtn').addEventListener('click', () => { G.camMode ^= 1; });
  $('mini').addEventListener('click', () => { $('mini').classList.toggle('big'); sizeMini(); });
}
