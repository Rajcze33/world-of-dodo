// Textures drawn on a canvas (signs, facades, the name tags' glow) and the DODO logo.
import { DynamicTexture, Texture } from '@babylonjs/core';
import { scene } from './engine';
import { LOGO_W } from './dom';

// Canvas textures are drawn again once the fonts have loaded (main.ts calls every entry).
export const TEXREG: (() => void)[] = [];
export type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;
// a w × h canvas texture drawn by draw; repeat: it tiles (u, v beyond 0..1); alpha: its transparent parts show through
export function canvasTex(w: number, h: number, draw: Draw, opt: { repeat?: boolean; alpha?: boolean } = {}): DynamicTexture {
  const t = new DynamicTexture('canvas', { width: w, height: h }, scene, true);
  const g = t.getContext() as unknown as CanvasRenderingContext2D;
  t.anisotropicFilteringLevel = 4;
  t.wrapU = t.wrapV = opt.repeat ? Texture.WRAP_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE;
  t.hasAlpha = !!opt.alpha;
  const paint = () => { g.clearRect(0, 0, w, h); draw(g, w, h); t.update(true); };
  paint(); TEXREG.push(paint);
  return t;
}
// a soft white spot fading out to the edge (the street lamps' pools of light, the impact dust)
export const poolTex = canvasTex(128, 128, g => {
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
}, { alpha: true });
export const logoTex = new Texture(LOGO_W, scene, false, true);
logoTex.hasAlpha = true;
logoTex.anisotropicFilteringLevel = 8;
logoTex.wrapU = logoTex.wrapV = Texture.CLAMP_ADDRESSMODE;
