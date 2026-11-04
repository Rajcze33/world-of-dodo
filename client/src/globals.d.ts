// The construction site's layout (client/shared/site.js, a classic script the page loads before the game; the server requires the
// same file). Every solid is a box standing on the ground.
interface SiteSolid {
  kind: string;
  x0: number; x1: number; z0: number; z1: number;
  h: number;
  color?: number;
  [more: string]: unknown;            // a few kinds carry more for their looks (a sand pile's r, a pipe's axis)
}

interface WodSite {
  area: { x0: number; x1: number; z0: number; z1: number };
  solids: SiteSolid[];
  [more: string]: unknown;            // gates, the crane and the rest the page draws
}

interface Window {
  WOD_SITE?: WodSite;
  WOD?: unknown;                      // the test hook (tools/browser-test.js), only with ?test
}
