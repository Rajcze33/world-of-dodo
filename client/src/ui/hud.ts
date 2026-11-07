// The page around the 3D view: the texts, the DODO logos, the toast line over the speed card, and the start button's fallback when
// the 3D cannot start.
//
// The page's first script (entry.ts; World of DODO, issue #31: before it, main.ts) imports this module first, before the 3D engine
// (core/engine.ts) is even downloaded. So the page gets its texts and the start button its "cannot start" line even when creating
// the engine throws (no WebGL), as the original's separate scripts before three.js did. That is why this module, unlike the others,
// does something when it is imported (initPage at the bottom).
import { $, COARSE, LOGO_W } from '../core/dom';
import { now } from '../core/util';
import { T } from '../texts';
import { LOAD } from './loading';

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
  $<HTMLImageElement>('hudLogo').src = LOGO_W; $<HTMLImageElement>('introLogo').src = LOGO_W; $<HTMLImageElement>('loadLogo').src = LOGO_W;
}

/* DODO web (scripts/dodo-christmas/game-start.js): when the 3D cannot run.
   The start button waits on "Načítám město" until the game is ready, and in the handoff that was the end of it when the 3D cannot
   run (no WebGL, or the 3D library not loaded): the game's code stops before it enables the button, which then says it is loading
   forever. The first uncaught error before the button is enabled puts a plain line there instead. main.ts also calls this when the
   boot throws.
   World of DODO, issue #31: the start button works at once now and the city is built behind the form, so "before the button is
   enabled" became "before the city is built": an uncaught error until then means the game cannot run here, and the button says so
   and stays off (LOAD.fail 'fatal'), also when a start is already loading. An error after the city is the game's (reported, the
   game goes on). */
export function noStart() { LOAD.fail(T.noStart, 'fatal'); }
function backstop() {
  if (LOAD.isDone('city')) return; removeEventListener('error', backstop);
  // World of DODO, issue #31: a start in flight ends first (main.ts abortRun: RUN, the socket, the pointer lock, 'intro'), or it would
  // wait for the city, connect and go on into the game behind the "cannot start" form. Before noStart, which closes the screen (then
  // isOpen() is false). A start still pending (main.ts not there yet) has nothing running: noStart's close() clears it.
  if (LOAD.isOpen() && !LOAD.pending) LOAD.on.cancel?.();
  noStart();
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
  addEventListener('error', backstop);
  applyTexts();
}
initPage();
