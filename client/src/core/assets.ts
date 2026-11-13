// World of DODO, issue #34: every texture file the game can show, downloaded before the game and kept for the whole visit.
//
// Before, a map was fetched when a material first asked for it at the current quality level, so every level change in the game
// (the automatic drop, or Q) downloaded, decoded and uploaded maps while the player drove: the streets went flat for a moment, and
// on a slow connection for seconds ("drive a little and the roads are worse again", issue #34). Now a file is wanted (want) the
// moment its material or its owner is made in the city's build, for every level at once, whatever the current level is; the
// loading screen's texture step (main.ts) waits until every wanted file is in (ASSET.pending 0). The bytes are kept as one Blob
// per file for the visit (some 3 MB, outside the JS heap); only the current level's maps are decoded and uploaded
// (core/matlib.ts), so the GPU memory per level is what it was, and a later level change reads Blobs only, no network.
//
// Why not something else: a fixed list of files would repeat what the materials know (core/matlib.ts wantFor) and go stale;
// decoded bitmaps of every level would cost some 56 MB of memory, every level on the GPU eleven times the low level's memory on the
// very devices that start on low; the Cache Storage would keep a second copy of what the HTTP cache has (the server's ETags make
// the next visit's revalidation cheap).
//
// The progress is counted in bytes as they come (the body read as a stream), against the files' Content-Length (a file without one,
// or compressed on the way, counts EST until it is in). A download that stalls (no byte of any file for STALL_MS while files are
// still on their way) is aborted and tried again at once: the server answers, slowly.
// World of DODO, issue #34: a refused or dropped connection or an error reply is tried again after 2, 4 and 8 s (retryLater; while
// the browser is offline, once it is online again), the file still on its way meanwhile, so the loading screen waits for it. Its
// tries used to come some 50 ms apart, so a server's restart (every push to main deploys) or a link that dropped for a second during
// the preload failed every file for the whole visit: the streets flat tints until a reload. After MAX_TRIES, or at once on a 404 or
// 410 (no such file), the file is failed: it counts as done, and its material keeps its tint (the stand-in). A file that failed on
// the network is asked for again the next time its map is wanted (blob(): a level change, Q), as the game did before the preload;
// a file that is not there is not.
//
// No Babylon here: main.ts reads ASSET for the loading screen, and this module is small.

// the numbers the loading screen and the tests read: files wanted, files in, files failed, files still on their way, bytes in, and
// bytes in all (Content-Length; EST for a file whose length is not known yet), and the files asked for that nobody had wanted (a
// level change in the game that would have to download: a map whose owner does not want it at build time, CONTRIBUTING.md)
export const ASSET = { files: 0, got: 0, failed: 0, pending: 0, bytes: 0, total: 0, miss: [] as string[] };
const EST = 65536;
const STALL_MS = 15000;
// World of DODO, issue #34: a file's tries, the wait after the first failure (doubled after each next one), and the longest wait for
// the browser to be online again (navigator.onLine can be wrong; then the try comes after this time all the same)
const MAX_TRIES = 4, RETRY_MS = 2000, OFFLINE_MS = 60000;
const TEST = new URLSearchParams(location.search).has('test');
// (?test: tools/browser-test.js may shorten the stall's time before the page loads, window.WOD_OVR.stallMs)
const stallMs = () => (TEST ? (window as unknown as { WOD_OVR?: { stallMs?: number } }).WOD_OVR?.stallMs : undefined) ?? STALL_MS;

// one file: its tries (MAX_TRIES at most), its length if known (0: not known), the bytes of this try, its Blob once in (null:
// failed), the running fetch's abort, and the promise everyone who asks for it gets
// (World of DODO, issue #34: net, its last failure was the network's or the server's, not a missing file: blob() asks again)
interface File { url: string; tries: number; len: number; got: number; done: boolean; blob: Blob | null; net: boolean; ctl: AbortController | null; p: Promise<Blob | null>; res: (b: Blob | null) => void }
const FILES = new Map<string, File>();
// the last moment a byte of any file came (or a fetch began): the stall's clock. One clock for all: the browser opens a few
// connections per server and queues the rest, so a file still queued is not stalled while the others come.
// (tick: the stall watch's last run, issue #34)
let lastByte = 0, watch = 0, tick = 0;

// the totals again (a few dozen files; called as the bytes come, in chunks of tens of kilobytes)
function count() {
  let got = 0, failed = 0, bytes = 0, total = 0;
  for (const f of FILES.values()) {
    bytes += f.got;
    if (f.done) { if (f.blob) got++; else failed++; total += f.got; }
    else total += f.len > 0 ? Math.max(f.len, f.got) : Math.max(EST, f.got);
  }
  ASSET.files = FILES.size; ASSET.got = got; ASSET.failed = failed; ASSET.pending = FILES.size - got - failed;
  ASSET.bytes = bytes; ASSET.total = total;
}

// A file the game may show: its download starts now (the browser queues it behind the others), once per file.
export function want(url: string): void { if (!FILES.has(url)) start(url); }
// The file's bytes, once in (null: it failed). A file nobody wanted before is fetched now, and listed in ASSET.miss.
// World of DODO, issue #34: a file that failed on the network is fetched again now: a material or owner asks only when it builds a
// Texture of it (core/matlib.ts: a level change, Q, the automatic quality going back up), and the outage that failed it may be long
// over. It is on its way again (ASSET.pending), so a Start after Esc waits for it as for any other (main.ts texAgainNow).
export function blob(url: string): Promise<Blob | null> {
  let f = FILES.get(url);
  if (!f) { ASSET.miss.push(url); f = start(url); }
  else if (f.done && !f.blob && f.net) {
    let res: (b: Blob | null) => void = () => {};
    f.p = new Promise<Blob | null>(r => { res = r; }); f.res = res;
    f.done = false; f.net = false; f.tries = 0; count();
    go(f);
  }
  return f.p;
}
// The file's bytes if they are in already (null: still on their way, failed, or never wanted).
export function blobNow(url: string): Blob | null { const f = FILES.get(url); return f && f.done ? f.blob : null; }

function start(url: string): File {
  let res: (b: Blob | null) => void = () => {};
  const p = new Promise<Blob | null>(r => { res = r; });
  const f: File = { url, tries: 0, len: 0, got: 0, done: false, blob: null, net: false, ctl: null, p, res };
  FILES.set(url, f); count();
  go(f);
  return f;
}
// a try now, and the stall watch running
function go(f: File) {
  lastByte = performance.now();                                   // (a file wanted after a quiet while is not stalled at once)
  void get(f);
  if (!watch) watch = window.setInterval(stalled, 1000);
}
// World of DODO, issue #34: go() after the tries-th failure of a download, once the wait it earns is over (RETRY_MS, doubled for each
// next one; offline, when the browser is online again, at most OFFLINE_MS); false: it has had its tries. A deploy's restart or a
// dropped link refuses every request at once, so a try right away fails too: the wait outlasts the short outages.
// (core/matlib.ts tries its index.json the same way)
export function retryLater(tries: number, next: () => void): boolean {
  if (tries >= MAX_TRIES) return false;
  let t = 0;
  const run = () => { clearTimeout(t); window.removeEventListener('online', run); next(); };
  if (navigator.onLine === false) { window.addEventListener('online', run); t = window.setTimeout(run, OFFLINE_MS); }
  else t = window.setTimeout(run, RETRY_MS * 2 ** (tries - 1));
  return true;
}
// one try: the body read as a stream, its bytes counted as they come
async function get(f: File) {
  f.tries++; f.got = 0; f.len = 0;
  const ctl = f.ctl = new AbortController();
  let status = 0;
  try {
    const r = await fetch(f.url, { signal: ctl.signal });
    status = r.status;
    if (!r.ok) throw new Error(f.url + ': ' + r.status);
    // the length on the wire is the body's length only when it comes as it is (a compressed reply's length is the compressed one)
    const enc = r.headers.get('content-encoding'), len = parseInt(r.headers.get('content-length') ?? '', 10);
    if ((!enc || enc === 'identity') && len > 0) f.len = len;
    lastByte = performance.now(); count();
    let b: Blob;
    if (r.body) {
      const rd = r.body.getReader(), parts: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value); f.got += value.byteLength; lastByte = performance.now(); count();
      }
      b = new Blob(parts as BlobPart[], { type: r.headers.get('content-type') || 'image/webp' });
    } else { b = await r.blob(); f.got = b.size; }
    f.ctl = null; f.done = true; f.blob = b; f.net = false; count(); f.res(b);
  } catch (_) {
    f.ctl = null; f.got = 0;
    // World of DODO, issue #34: again (a stall's abort at once, the server answers; a refused or dropped connection or an error reply
    // after a wait, retryLater), the file still on its way meanwhile; after its tries, or a file that is not there (404, 410), it is
    // failed: its material keeps its tint, and one that failed on the network (net) is asked for again by the next blob()
    const gone = status === 404 || status === 410;
    f.net = !gone;
    if (!gone && f.tries < MAX_TRIES) {
      count();
      if (ctl.signal.aborted) go(f); else retryLater(f.tries, () => go(f));
      return;
    }
    f.done = true; f.blob = null; count(); f.res(null);
  }
  if (!ASSET.pending && watch) { clearInterval(watch); watch = 0; }
}
// once a second while files are on their way: nothing came for the stall's time, so every running download is aborted (get()
// tries it again, or gives it up), and the clock starts again for the new tries
// (World of DODO, issue #34: a run far behind its second means the page was frozen, a phone's app switch or a laptop's sleep, and
// its downloads with it: the clock starts again rather than abort them all at once and spend a try of each)
function stalled() {
  if (!ASSET.pending) { clearInterval(watch); watch = 0; return; }
  const now = performance.now(), gap = now - tick; tick = now;
  if (gap > 5000) { lastByte = now; return; }
  if (now - lastByte < stallMs()) return;
  lastByte = now;
  for (const f of FILES.values()) if (!f.done && f.ctl) f.ctl.abort();
}

// the tests' handle (?test, as core/matlib.ts's wodMat): the numbers above, live
if (TEST) (window as unknown as { wodAssets: typeof ASSET }).wodAssets = ASSET;
