// What the page adds to window. World of DODO, issue #16: the construction site's layout is no longer a classic script setting
// window.WOD_SITE (client/shared/site.js); the game imports it as SITE from client/shared/map.ts.
interface Window {
  WOD?: unknown;                      // the test hook (tools/browser-test.js), only with ?test
}
