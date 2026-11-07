// World of DODO, issue #31: the page's first script. The join form works the moment the page shows; the game comes after it.
//
// Before, the page had one script of 7.6 MB (1.3 MB brotli): Babylon.js, the map of Karlín and the game, evaluated in one task,
// and only after it the form had its texts and behaviour and the city was built, in one more long task, before Start was enabled.
// Now this light script (no Babylon, no map: tools/smoke.js checks it stays under 60 KB) puts the texts in, fills the form and
// enables Start, and only then loads the game in stages, each a task of its own:
//   1. core/engine.ts (Babylon, the engine; it throws without WebGL) and client/shared/map.ts (karlin.json and the city derived from
//      it) together: two separate graphs, so both download at once and each evaluates in its own task;
//   2. main.ts and the rest of the game, which builds the city in slices (core/slice.ts) behind the form.
// A Start meanwhile opens the loading screen (ui/loading.ts) and waits there (LOAD.pending) until main.ts takes it.
//
// What went wrong in a stage: nothing of a module graph runs before all of it is downloaded, so a stage rejected before its first
// module ran (core/evalmark1.ts / evalmark3.ts set window.WOD_EVAL to 1 / 3; the map has no such mark: its evaluation cannot throw
// in a browser that got this far) was not downloaded: a network error, or a deploy changed the files' names since this page was
// loaded. Reloading helps (T.errLoad, 'reload'). A stage that rejected after its code began to run threw: no WebGL, or a browser
// too old for the game (T.noStart, 'fatal').
import './ui/hud';                     // the texts and the "cannot start" backstop, first (see ui/hud.ts)
import { T } from './texts';
import { LOAD } from './ui/loading';
import { joinForm } from './ui/join';
import { yieldNow } from './core/slice';

const TEST = new URLSearchParams(location.search).has('test');
if (TEST) window.WOD_LOAD = LOAD;     // tools/browser-test.js reads the steps, the marks and the trace

joinForm();                            // the form, filled from this browser's storage, Start enabled
LOAD.t.form = performance.now();
LOAD.progress('city', 0.02);           // (the line under Start shows from the first moment)

const mark = (k: string) => () => { LOAD.t[k] = performance.now(); };
// stage 1 or 2 failed: rejected before its code ran (not downloaded) or after (it threw)
function failed(stage: number, e: unknown) {
  console.error(e);
  if ((window.WOD_EVAL ?? 0) >= stage) LOAD.fail(T.noStart, 'fatal');
  else LOAD.fail(T.errLoad, 'reload');
}

async function go() {
  LOAD.t.import = performance.now();
  const [eng, map] = await Promise.allSettled([
    import('./core/engine').then(mark('engine')),
    import('../shared/map.ts').then(mark('map')),
  ]);
  if (eng.status === 'rejected') return failed(1, eng.reason);
  if (map.status === 'rejected') return failed(99, map.reason);   // (the map has no mark: not downloaded)
  LOAD.progress('city', 0.1);
  await yieldNow();                    // the page answers its input between the stages
  try { await import('./main'); } catch (e) { return failed(3, e); }
  LOAD.t.code = performance.now();
  LOAD.progress('city', 0.2);          // (CITY_CODE in ui/loading.ts: main.ts's build fills the rest)
}

// The import waits for the form's first frame (requestAnimationFrame, then a task), so the form is on the screen before the first
// stage's task. A background tab has no frames (MDN: requestAnimationFrame is paused there), so there it starts at once. ?test may
// hold it back (WOD_OVR.importDelay, a slow download).
const delay = TEST ? Math.max(0, Number(window.WOD_OVR?.importDelay) || 0) : 0;
const kick = () => setTimeout(go, delay);
if (document.hidden) kick(); else requestAnimationFrame(kick);
