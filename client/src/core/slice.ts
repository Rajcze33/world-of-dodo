// World of DODO, issue #31: long work in slices, so the page stays alive while the city is built behind the join form.
//
// The boot (main.ts) and the builders (world/*.ts) are generators that `yield` between units of work (a house, a street, a tile
// kind's bake, ...); `run` steps one through and gives the page back every SLICE_MS, so a key typed into the name field is
// answered within a slice, not after the whole city. A unit itself is never cut: everything that draws from `R` or registers a
// prop runs inside one unit in today's order, so the city is the same on every page (CONTRIBUTING.md).
//
// Giving the page back: a MessageChannel message, a task of its own like setTimeout(0) but not clamped to 4 ms after a few nested
// calls (HTML's timer rules), so 300 slices do not cost 1.2 s of waiting. It queues behind what is already waiting, so the page's
// other tasks get their turn between two slices. Not scheduler.yield() (Chrome 129, Firefox 142), which the brief of issue #31
// named first: its continuation is put before the page's other tasks, and a long run of slices (the shaders' pre-warm, main.ts,
// which goes on beside a start's connection) then starved the WebSocket's events and the timers. Measured in headless Chrome
// (software WebGL, two pages): a socket made right after the city did not even open in 40 s, the start failed with "the server
// cannot be reached"; with the message it opened, was welcomed and got its first snapshot within 4 s of the city.

// a unit of work, or a chain of them: each `yield` is a place where the page may be given back; a number yielded is how much of
// the whole is done (0..1), for the progress bar (ui/loading.ts)
export type Work = Generator<number | void, void, void>;

// how long one slice may run before the page gets a turn: a 60 Hz frame is 16.7 ms, a key's answer within ~50 ms feels instant
// (RAIL); 10 ms leaves the browser room for its own work in the same frame
export const SLICE_MS = 10;

// what the slicing measured (?test: tools/browser-test.js, the report): the longest unit between two yields (ms), the units run,
// and which unit it was (its number, counted over every run)
export const SLICE = { longest: 0, units: 0, at: 0 };

// one channel for every yield: the resolvers wait in order, one message wakes one
const CH = typeof MessageChannel === 'function' ? new MessageChannel() : null;
const WAKE: (() => void)[] = [];
if (CH) CH.port1.onmessage = () => { WAKE.shift()?.(); };

// gives the page back once (input, rendering, the network, timers) and resumes after what was waiting
export function yieldNow(): Promise<void> {
  if (CH) return new Promise(r => { WAKE.push(r); CH.port2.postMessage(0); });
  return new Promise(r => setTimeout(r, 0));
}

// runs w to its end, giving the page back whenever a slice has run budget ms; onFrac hears every fraction w yields. Rejects with
// what w throws.
export async function run(w: Work, onFrac?: (f: number) => void, budget = SLICE_MS): Promise<void> {
  let slice = performance.now();
  for (;;) {
    const u = performance.now(), r = w.next(), t = performance.now();
    SLICE.units++;
    if (t - u > SLICE.longest) { SLICE.longest = t - u; SLICE.at = SLICE.units; }
    if (r.done) return;
    if (onFrac && typeof r.value === 'number') onFrac(r.value);
    if (t - slice >= budget) { await yieldNow(); slice = performance.now(); }
  }
}
