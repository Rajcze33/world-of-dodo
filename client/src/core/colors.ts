// The DODO palette, as 0xRRGGBB. Colours are used as they are (no colour management), as the original did.
import { Color3, Color4 } from '@babylonjs/core';

export const COL = {
  green: 0x27a28c, teal: 0x00746a, charcoal: 0x3d4543, light: 0xb2dcd6, white: 0xffffff, lgrey: 0xeaebeb, grey: 0xadb1b0,
  c80: 0x555c5a, c60: 0x797e7d, c20: 0xd6d8d7, paper: 0xf5f7f6, ink: 0x000000,
} as const;

export const c3 = (hex: number) => new Color3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
export const c4 = (hex: number, a = 1) => new Color4(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, a);
// r, g, b of a hex colour (0..1), written into out at offset
export function rgbInto(hex: number, out: number[] | Float32Array, at: number) {
  out[at] = ((hex >> 16) & 255) / 255; out[at + 1] = ((hex >> 8) & 255) / 255; out[at + 2] = (hex & 255) / 255;
}
