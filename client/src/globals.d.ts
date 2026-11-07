// What the page adds to window. World of DODO, issue #16: the construction site's layout is no longer a classic script setting
// window.WOD_SITE (client/shared/site.js); the game imports it as SITE from client/shared/map.ts.
interface Window {
  WOD?: unknown;                      // the test hook (tools/browser-test.js), only with ?test
  // World of DODO, issue #31: how far the game's code got: 1 when core/engine.ts's stage began to run (core/evalmark1.ts), 3 when
  // main.ts's did (core/evalmark3.ts). entry.ts tells a stage that was not downloaded (unset) from one that threw (set).
  WOD_EVAL?: number;
  WOD_LOAD?: typeof import('./ui/loading').LOAD;   // issue #31: the loading screen's numbers (ui/loading.ts), only with ?test
  // issue #31, only with ?test: what tools/browser-test.js changes before the page loads: another server (ws), the time limits
  // (ms) of the textures, the connection and the first snapshot, a welcome or the first snapshot never let through (hold), and a
  // delay (ms) before entry.ts imports the game (a slow download)
  WOD_OVR?: { ws?: string; texMs?: number; connectMs?: number; snapMs?: number; hold?: 'welcome' | 'snap'; importDelay?: number };
}
