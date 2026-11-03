// The page around the 3D view: the texts, the DODO logos, the toast line over the speed card, and the start button's fallback when
// the 3D cannot start.
//
// main.ts imports this module first, before the 3D engine (core/engine.ts) is evaluated. So the page gets its texts and the start
// button its "cannot start" line even when creating the engine throws (no WebGL), as the original's separate scripts before three.js
// did. That is why this module, unlike the others, does something when it is imported (initPage at the bottom).
import { $, COARSE, LOGO_W } from '../core/dom';
import { now } from '../core/util';
import { T } from '../texts';

// The texts into the page (orig. applyT): data-t → text, data-ta → aria-label, data-tp → placeholder; the keys hint for a keyboard
// or for a touch screen
function text(key: string | undefined): string { const v = (T as Record<string, unknown>)[key ?? '']; return v == null ? '' : String(v); }
function applyTexts() {
  if (T.docTitle) document.title = T.docTitle;
  document.documentElement.lang = T.lang;
  document.querySelectorAll<HTMLElement>('[data-t]').forEach(el => { el.textContent = text(el.dataset.t); });
  document.querySelectorAll<HTMLElement>('[data-ta]').forEach(el => { el.setAttribute('aria-label', text(el.dataset.ta)); });
  document.querySelectorAll<HTMLElement>('[data-tp]').forEach(el => { el.setAttribute('placeholder', text(el.dataset.tp)); });
  $('keysDesk').hidden = COARSE; $('keysTouch').hidden = !COARSE;
  $<HTMLImageElement>('hudLogo').src = LOGO_W; $<HTMLImageElement>('introLogo').src = LOGO_W;
}

/* DODO web (scripts/dodo-christmas/game-start.js): when the 3D cannot run.
   The start button waits on "Načítám město" until the game is ready, and in the handoff that was the end of it when the 3D cannot
   run (no WebGL, or the 3D library not loaded): the game's code stops before it enables the button, which then says it is loading
   forever. The first uncaught error before the button is enabled puts a plain line there instead. main.ts also calls this when the
   boot throws. */
export function noStart() {
  const b = $<HTMLButtonElement>('startBtn'), l = $('startLbl');
  if (!b || !b.disabled || !l) return;
  l.textContent = T.noStart;
}

// one line over the speed card: the start hint, hits, network news; set again only when it changes (it fades in and out)
let toastMsg = '';
export function toast(m: string) {
  if (m === toastMsg) return; toastMsg = m;
  const t = $('toast');
  if (m) { t.textContent = m; t.classList.remove('off'); } else t.classList.add('off');
}
// a message for 3.5 s; the drive loop shows it in the toast (game/tank.ts updateDrive), over the start hint
export let flashMsg = '', flashUntil = 0;
export function flash(m: string) { flashMsg = m; flashUntil = now() + 3500; }

function initPage() {
  addEventListener('error', noStart, { once: true });
  applyTexts();
}
initPage();
