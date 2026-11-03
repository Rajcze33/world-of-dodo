// The page around the 3D view (client/index.html): the HUD, the touch controls, the join form.
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// a phone or a tablet: touch controls, a lighter picture
export const COARSE = matchMedia('(pointer:coarse)').matches || (navigator.maxTouchPoints > 0 && matchMedia('(hover:none)').matches);
// the DODO wordmark (white): HUD, intro screen, depot wall, turrets
export const LOGO_W = '/assets/logo-white.png';
