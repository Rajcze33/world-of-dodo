// World of DODO, issue #31: the loading screen between the join form and the game.
//
// After Start the game waits for five steps (STEPS): the city (the code and the build, usually done behind the form already), the
// textures (or their time limit), the connection (welcome), the game's first state (the first snapshot) and the shaders (the
// pre-warm, the cells near the spawn, three frames). One bar shows them all, each weighted by how long it takes (STEP_W), and never
// goes back; its label is the first step not done yet. main.ts drives the steps (begin, progress, done, enter, fail); this module
// only shows them and answers Cancel and Esc. It is part of the page's first, light script (entry.ts): no Babylon here.
//
// Before Start the same numbers drive one line under the start button (T.cityBg): the city being built in the background.
//
// Timing (all performance.now(), ms since the navigation): LOAD.t holds the marks: form (the form works), import, engine, map, code
// (entry.ts's import stages), eval1 / eval3 (core/evalmark1.ts, evalmark3.ts: a stage's code began to run), pending (a Start
// before main.ts was there), open (the last Start), and each step's done.
import { $, COARSE } from '../core/dom';
import { T } from '../texts';
import { joinErr, type Join } from './join';

export type StepId = 'city' | 'tex' | 'net' | 'snap' | 'warm';
export const STEPS: readonly StepId[] = ['city', 'tex', 'net', 'snap', 'warm'];
// Each step's share of the bar: how long it takes against the others. World of DODO, issue #31: the medians of three runs (a GPU
// laptop, high quality, DevTools' Fast 4G, the city built after Start), each step from its own start: the city 4162 ms (from
// Start), the textures 1602, the connection 298, the first state 53, the shaders ~1080 (to the three frames). The steps after the
// city run side by side, so these are shares of their sum, not of the time on the clock. Not learnt per browser (a first visit has
// nothing to learn from) and not by time (a stalled step would move the bar while nothing happens).
// World of DODO, issue #34: measured again, the medians of six runs (the same laptop, 1536 x 730 at 1.25, Fast 4G, Start at the
// form's first moment), now that the texture step waits for every file of every level (29 files, 3.0 MB) and their uploads: the
// city 6549 ms, the textures 1088 after the city (most of the files come during the build), the connection 582, the first state
// 113, the shaders 2096.
export const STEP_W: Record<StepId, number> = { city: 63, tex: 10, net: 6, snap: 1, warm: 20 };
// The city step's first part is the code (entry.ts: the engine and the map, then the game's own); the build fills the rest. main.ts
// reports its build as progress('city', CITY_CODE + (1 - CITY_CODE) * f).
export const CITY_CODE = 0.2;
// how long after Start the screen shows (a start done sooner goes straight in, no flash of a screen); how long an error stays on it
const SHOW_MS = 250, ERR_MS = 1200, FADE_MS = 250;
// Esc in the first moments after Start is the same key press's repeat or a slip, not a wish to go back
const KEY_DEAD_MS = 300;

export type FailHow = 'screen' | 'form' | 'reload' | 'fatal';
// (note: World of DODO, issue #34: a line under the step's name, main.ts says what: the textures' megabytes, files that failed)
interface Step { f: number; done: boolean; late: boolean; err: boolean; note: string }
const ST = Object.fromEntries(STEPS.map(id => [id, { f: 0, done: false, late: false, err: false, note: '' }])) as Record<StepId, Step>;

let opened = false;          // a start is on: from open() to enter(), close() or fail()
let shown = false;           // the screen is up (SHOW_MS after open)
let openAt = 0;              // when the last start was clicked
let pct = 0;                 // the bar as shown in this start, never back
let pre: StepId[] = [];      // what was done when this start began (begin)
let fatal = false;           // the game cannot run here: the start button stays off
let showT = 0, errT = 0, fadeT = 0, raf = 0;
let errMsg = '';             // the message on the screen while it says why it goes back (fail 'screen')

// The longest task the browser saw from the end of the game's code's evaluation (t.code) to the city's end: the slices' worst
// (core/slice.ts). Not from t.eval3: main.ts's evaluation is one task with the first slice in it, an import stage (its own budget,
// 300 ms), and whether it counted hung on a sub-millisecond race between its start and evalmark3's clock (both clamped). Long
// tasks are observed from the first script on; where the browser has no Long Tasks API it stays 0.
// World of DODO, issue #31: only that window is ever read, so nothing after the city is kept (on a slow phone every game frame is a
// long task: the list would grow for the whole game) and the observer stops at the first task after it. Long tasks do not overlap,
// so they come in start order; the callback runs after this module has run (observer callbacks are always asynchronous).
const LONG: [number, number][] = [];
try {
  new PerformanceObserver((l, o) => {
    const end = LOAD.t.city;
    for (const e of l.getEntries()) { if (end !== undefined && e.startTime > end) { o.disconnect(); break; } LONG.push([e.startTime, e.duration]); }
  }).observe({ type: 'longtask', buffered: true });
} catch (_) { /* not supported */ }

export const LOAD = {
  t: {} as Record<string, number>,
  // a Start clicked before main.ts set on.start (a returning player clicks within the first moments): main.ts runs it when it is
  // there; Cancel meanwhile only clears it
  pending: null as { join: Join; at: number } | null,
  // what main.ts does on a start (startRun) and on Cancel or Esc while loading (abortRun)
  on: {} as { start?: (j: Join) => void; cancel?: () => void },
  // this start's bar: [ms since Start, percent shown, the label's step] at every change (?test: tools/browser-test.js)
  trace: [] as [number, number, StepId][],
  // the last start that got into the game: the steps done before it began, the ones done late (their time limit), ms from Start
  last: null as { pre: StepId[]; late: StepId[]; ms: number } | null,
  get longest() {
    const a = LOAD.t.code ?? Infinity, b = LOAD.t.city ?? Infinity;   // (see LONG above: from main.ts's evaluation's end)
    let m = 0; for (const [s, d] of LONG) if (s >= a && s <= b && d > m) m = d;
    return m;
  },
  // a part of the game could not be downloaded: the start button reloads the page (fail 'reload')
  reloadOnly: false,
  // a start begins (main.ts, from on.start): the network's steps again; the city and the textures stay as they are (a new start
  // after Esc waits only for the network). texAgain: main.ts found maps on their way again at this Start (World of DODO, issue #31:
  // a quality change since the textures came, Q in the menu or the automatic drop before an Esc, asked for other maps): the
  // textures' step again too, so this start waits for them (its time limit from this Start) and they do not upload in the game
  begin(texAgain = false) {
    for (const id of STEPS) {
      const s = ST[id]; s.err = false;
      if (id === 'net' || id === 'snap' || id === 'warm' || (id === 'tex' && texAgain)) { s.f = 0; s.done = false; s.late = false; }
    }
    // World of DODO, issue #31: what was done before this start, taken after the reset: the last game's network steps are not this
    // start's (before, after a game and Esc, every step looked done before the new start)
    pre = STEPS.filter(id => ST[id].done);
    // the bar again from 0: open()'s changed() has just counted the last game's network steps as done (100 %), and the bar never
    // goes back by itself
    pct = 0; LOAD.trace = []; changed();
  },
  // how far step id is (0..1); a step never goes back
  progress(id: StepId, f: number) {
    const s = ST[id]; if (s.done) return;
    f = Math.max(0, Math.min(1, f)); if (!(f > s.f)) return;
    s.f = f; changed();
  },
  // step id is done; late: by its time limit (the textures: they finish in the game, T.loadTexLate). Done again without late (the
  // textures came after all) clears late.
  done(id: StepId, late = false) {
    const s = ST[id]; if (s.done && (s.late === late || late)) return;
    s.done = true; s.f = 1; s.late = late; s.err = false; LOAD.t[id] = performance.now(); changed();
  },
  isDone: (id: StepId) => ST[id].done,
  // World of DODO, issue #34: the line under a step's name ('' none); a step done late says that instead (the textures: T.loadTexLate)
  note(id: StepId, text: string) {
    const s = ST[id]; if (s.note === text) return;
    s.note = text; paintSoon();
  },
  isOpen: () => opened,
  // Start (ui/join.ts): the form is set aside, the screen comes up SHOW_MS later, and the game is asked to start
  open(j: Join) {
    if (opened || fatal) return;
    const now = performance.now();
    opened = true; shown = false; openAt = now; LOAD.t.open = now; pct = 0; LOAD.trace = []; errMsg = '';
    clearTimeout(errT); clearTimeout(fadeT); errT = fadeT = 0;
    const form = $('joinForm');
    if (document.activeElement instanceof HTMLElement && form.contains(document.activeElement)) document.activeElement.blur();
    form.inert = true; $('startLbl').textContent = T.loadBtn;
    $('loadTitle').textContent = T.loadTitle[j.veh];
    $('loadKeys').textContent = j.veh === 1 ? (COARSE ? T.hintPlane : T.hintPlaneDesk) : j.veh === 2 ? (COARSE ? T.hintShip : T.hintShipDesk) : (COARSE ? T.hintStart : T.hintStartDesk);
    $('loadErr').hidden = true;
    addEventListener('keydown', onKey);
    showT = window.setTimeout(show, SHOW_MS);
    changed();
    if (LOAD.on.start) LOAD.on.start(j);
    else { LOAD.pending = { join: j, at: now }; LOAD.t.pending = now; }
  },
  // back to the form, nothing to say (Cancel, Esc, the menu)
  close() {
    end(); clearTimeout(fadeT); fadeT = 0;
    $('loading').hidden = true; $('loading').classList.remove('out'); $('intro').hidden = false;
    $('joinForm').inert = false;
    const b = $<HTMLButtonElement>('startBtn');
    b.disabled = fatal; $('startLbl').textContent = fatal ? T.noStart : LOAD.reloadOnly ? T.reload : T.start;
    joinErr('');
    if (!COARSE && !fatal) $('nameIn').focus();
    paintSoon();
  },
  // into the game (main.ts enterGame): the bar full, the screen fades out
  enter() {
    if (!opened) return;
    const now = performance.now(), was = shown;
    if (pct < 100) { pct = 100; LOAD.trace.push([Math.round(now - openAt), 100, 'warm']); }
    LOAD.last = { pre, late: STEPS.filter(id => ST[id].late), ms: Math.round(now - openAt) };
    if (was) paint();                                                // (the full bar for the fade)
    end();
    $('intro').hidden = true;
    const el = $('loading');
    // the fade is a transition (none under prefers-reduced-motion), so the screen is hidden by a timer, not by transitionend
    if (was) { el.classList.add('out'); fadeT = window.setTimeout(() => { el.hidden = true; el.classList.remove('out'); fadeT = 0; }, FADE_MS); }
    else el.hidden = true;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();   // the keys go to the game, not to the screen's title
  },
  // the start failed (main.ts abortRun, entry.ts, the error backstop in ui/hud.ts):
  //   'screen': the step turns peach and the message shows ERR_MS on the screen, then the form with it under it;
  //   'form':   the form at once with the message (the server refused the name, the game is full);
  //   'reload': the message, and the start button reloads the page (a part of the game was not downloaded);
  //   'fatal':  the game cannot run in this browser: the start button says so and stays off.
  fail(msg: string, how: FailHow) {
    if (how === 'fatal') fatal = true;
    if (how === 'reload') LOAD.reloadOnly = true;
    if (how === 'screen' && opened && shown) {
      const cur = STEPS.find(id => !ST[id].done); if (cur) ST[cur].err = true;
      errMsg = msg; $('loadErr').textContent = msg; $('loadErr').hidden = false; paint();
      clearTimeout(errT); errT = window.setTimeout(() => back(msg), ERR_MS);
      return;
    }
    back(how === 'fatal' ? '' : msg);
  },
};

// the start is over one way or another: no timers, no keys, nothing pending
function end() {
  clearTimeout(showT); clearTimeout(errT); showT = errT = 0; errMsg = '';
  opened = false; shown = false; LOAD.pending = null;
  removeEventListener('keydown', onKey);
}
// to the form with a message under it
function back(msg: string) { LOAD.close(); if (msg) { joinErr(msg); if (!COARSE && !fatal) $('nameIn').focus(); } }

// the screen comes up (if the start has not got into the game sooner); the intro goes only now, so a quick start never flashes it
function show() {
  showT = 0; if (!opened) return;
  shown = true; clearTimeout(fadeT); fadeT = 0;
  const el = $('loading'); el.classList.remove('out'); el.hidden = false; $('intro').hidden = true;
  paint();
  $('loadTitle').focus({ preventScroll: true });                   // a screen reader starts on the title; Esc and Tab work from here
}

// Esc while loading: back to the form (not a held key's repeat, not in the first moments). Cancel the same.
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.repeat || performance.now() - openAt < KEY_DEAD_MS) return;
  e.preventDefault(); cancel();
}
function cancel() {
  if (!opened) return;
  LOAD.t.cancel = performance.now();                               // (?test: tools/browser-test.js checks when it came)
  if (errMsg) { back(errMsg); return; }                            // already going back: at once
  if (LOAD.pending || !LOAD.on.cancel) { LOAD.pending = null; LOAD.close(); return; }
  LOAD.on.cancel();
}

// the numbers changed: the bar's value (never back while a start is on), its trace, and a paint in the next frame
function changed() {
  let sw = 0, sf = 0, all = true;
  for (const id of STEPS) { sw += STEP_W[id]; sf += STEP_W[id] * ST[id].f; if (!ST[id].done) all = false; }
  const n = all ? 100 : Math.min(99, Math.floor(sf / sw * 100));
  if (opened) {
    if (n > pct) pct = n;
    const cur = STEPS.find(id => !ST[id].done) ?? 'warm', l = LOAD.trace[LOAD.trace.length - 1];
    if (!l || l[1] !== pct || l[2] !== cur) LOAD.trace.push([Math.round(performance.now() - openAt), pct, cur]);
  }
  paintSoon();
}
function paintSoon() { if (!raf) raf = requestAnimationFrame(paint); }

// the page as the numbers say: before Start the city's line under the start button; while a start is on the bar, the percent, the
// label (a screen reader hears the step change, not every percent) and the steps' list
function paint() {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  const bg = $('cityBg'), city = ST.city;
  const bgOn = !opened && !city.done && !fatal && !LOAD.reloadOnly;
  if (bg.hidden === bgOn) bg.hidden = !bgOn;
  if (bgOn) bg.textContent = T.cityBg(Math.floor(city.f * 100));
  if (!opened || !shown) return;
  const cur = STEPS.find(id => !ST[id].done), label = T.loadSteps[STEPS.indexOf(cur ?? 'warm')];
  $('loadFill').style.transform = 'scaleX(' + pct / 100 + ')';
  $('loadPct').textContent = T.pct(pct);
  if ($('loadStep').textContent !== label) $('loadStep').textContent = label;
  const bar = $('loadBar');
  bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuetext', T.loadVal(pct, label));
  document.querySelectorAll<HTMLElement>('#loadSteps li').forEach((li, i) => {
    const s = ST[STEPS[i]], run = !s.done && (STEPS[i] === cur || s.f > 0);
    li.classList.toggle('done', s.done); li.classList.toggle('run', run && !s.err); li.classList.toggle('err', s.err);
    const note = s.done && s.late && STEPS[i] === 'tex' ? T.loadTexLate : s.note;
    const t = li.querySelector<HTMLElement>('.t')!; if (t.textContent !== note) t.textContent = note;
  });
}

// the steps' list, once (the texts are in by now: ui/hud.ts runs first)
function buildSteps() {
  const ck = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  $('loadSteps').innerHTML = STEPS.map((_, i) => '<li><span class="n"><b>' + (i + 1) + '</b>' + ck + '</span><span class="nm"></span><span class="t meta"></span></li>').join('');
  document.querySelectorAll<HTMLElement>('#loadSteps .nm').forEach((e, i) => { e.textContent = T.loadSteps[i]; });
  $('loadCancel').textContent = COARSE ? T.loadCancelTouch : T.loadCancel;
  $('loadCancel').addEventListener('click', cancel);
}
buildSteps();
paintSoon();
